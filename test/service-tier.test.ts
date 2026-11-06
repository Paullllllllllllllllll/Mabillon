import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createChronoExtension } from "../src/agent/extension.ts";
import type { SessionRuntime } from "../src/agent/runtime.ts";
import { docPaths } from "../src/agent/state.ts";
import { createTuiExtension } from "../src/agent/tui-extension.ts";
import { parseArgs } from "../src/cli.ts";
import { coerceConfigValue, loadConfigFile, mergeConfig } from "../src/config.ts";
import { classifyProviderError, run } from "../src/driver.ts";
import { resolveImageProfile } from "../src/inputs/image-profile.ts";
import { resolveSchema } from "../src/schemas/registry.ts";
import {
	applyServiceTier,
	checkServiceTierRoute,
	FLEX_RETRY_DELAYS,
	isOpenAIResponses,
	retryDelaysFor,
	withServiceTier,
} from "../src/service-tier.ts";
import { createFauxRuntime, makeImageFolder, tempDir } from "./helpers.ts";

const openai = { provider: "openai", id: "gpt-6-luna", api: "openai-responses" };

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** The before_provider_request handler of an extension factory, called with a fresh payload. */
function hookOf(factory: (pi: never) => void): (ctx?: unknown) => Promise<Record<string, unknown>> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: () => undefined,
		sendMessage: () => undefined,
	};
	factory(pi as never);
	return async (ctx) => {
		const payload: Record<string, unknown> = { model: "gpt-6-luna", input: [] };
		await handlers.get("before_provider_request")?.({ type: "before_provider_request", payload }, ctx);
		return payload;
	};
}

/** A model runtime with pi's built-in providers and the given auth.json. */
async function runtimeWithAuth(
	auth: Record<string, unknown>,
): Promise<{ modelRuntime: ModelRuntime; agentDir: string }> {
	const agentDir = tempDir("mabillon-agentdir-");
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	return { modelRuntime, agentDir };
}

const chatgptLogin = {
	openai: { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 86_400_000 },
};

describe("OpenAI service tier", () => {
	it("parses the tier from the command line and the yaml file", () => {
		expect(parseArgs(["transcribe", "book.pdf", "--service-tier", "flex"]).overrides.serviceTier).toBe("flex");
		const dir = tempDir();
		const file = join(dir, "mabillon.yaml");
		writeFileSync(file, "service_tier: Priority\n");
		expect(loadConfigFile(file)).toEqual({ serviceTier: "priority" });
		expect(mergeConfig({}).serviceTier).toBeUndefined();
		expect(() => coerceConfigValue("serviceTier", "scale", ".")).toThrow(
			/must be one of flex, priority, auto, default/,
		);
	});

	it("accepts only OpenAI models used with an API key", () => {
		expect(isOpenAIResponses(openai)).toBe(true);
		expect(() => checkServiceTierRoute("flex", openai, "api_key")).not.toThrow();
		expect(() => checkServiceTierRoute("flex", openai, "oauth")).toThrow(/ChatGPT login/);
		expect(() => checkServiceTierRoute("flex", openai, undefined)).toThrow(/no OpenAI API key/);
		for (const model of [
			{ provider: "openrouter", id: "openai/gpt-6-luna", api: "openai-completions" },
			{ provider: "openai-codex", id: "gpt-6-luna", api: "openai-codex-responses" },
			{ provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" },
		]) {
			expect(isOpenAIResponses(model)).toBe(false);
			expect(() => checkServiceTierRoute("flex", model, "api_key")).toThrow(/applies only to OpenAI models/);
		}
		expect(() => checkServiceTierRoute("priority", undefined, undefined)).toThrow(/needs an OpenAI model/);
	});

	it("tells an API key from the ChatGPT login through pi's credentials", async () => {
		const withKey = await runtimeWithAuth({ openai: { type: "api_key", key: "sk-test" } });
		expect((await withKey.modelRuntime.checkAuth("openai"))?.type).toBe("api_key");
		const withLogin = await runtimeWithAuth(chatgptLogin);
		expect((await withLogin.modelRuntime.checkAuth("openai"))?.type).toBe("oauth");
		// Both use the same provider and API.
		const model = withLogin.modelRuntime.getModels("openai")[0];
		expect(isOpenAIResponses(model)).toBe(true);
	});

	it("refuses the tier at the start of a run for other routes, before any document is touched", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "book"), 1);
		const out = join(root, "out");
		const setup = await createFauxRuntime(() => {
			throw new Error("no request expected");
		});
		try {
			await expect(
				run({
					mode: "transcribe",
					inputs: [folder],
					config: mergeConfig({ model: "faux/faux-1", serviceTier: "flex", out }),
					log: () => undefined,
					services: { modelRuntime: setup.modelRuntime, agentDir: setup.agentDir, settings: {} },
				}),
			).rejects.toThrow(/applies only to OpenAI models/);
		} finally {
			setup.cleanup();
		}
		const login = await runtimeWithAuth(chatgptLogin);
		const id = login.modelRuntime.getModels("openai")[0].id;
		await expect(
			run({
				mode: "transcribe",
				inputs: [folder],
				config: mergeConfig({ model: `openai/${id}`, serviceTier: "flex", out }),
				log: () => undefined,
				services: { modelRuntime: login.modelRuntime, agentDir: login.agentDir, settings: {} },
			}),
		).rejects.toThrow(/ChatGPT login/);
		expect(existsSync(out)).toBe(false);
	}, 60_000);

	it("sets service_tier in the batch hook only when the session has a tier", async () => {
		const units = [{ id: "p0001", index: 1, status: "pending" as const }];
		const runtime = {
			workDir: tempDir(),
			paths: docPaths(tempDir()),
			mode: "transcribe",
			inputKind: "images",
			schema: resolveSchema(undefined, "transcribe", []),
			config: mergeConfig({ serviceTier: "flex" }),
			state: { units, stem: "x" },
			batch: units,
			tools: new Set(["read", "write", "edit", "view", "verify"]),
			documentLabel: "x",
			contextImages: [],
			imageProfile: resolveImageProfile(openai, "standard"),
			serviceTier: "flex",
			sources: { image: () => undefined, text: () => "", materialize: () => undefined },
			persist: () => undefined,
			log: () => undefined,
		} as unknown as SessionRuntime;
		const hook = hookOf(createChronoExtension(runtime).factory);
		expect((await hook()).service_tier).toBe("flex");
		// The driver leaves the session's tier unset for models off the route.
		runtime.serviceTier = undefined;
		expect(await hook()).not.toHaveProperty("service_tier");
	});

	it("sets service_tier in the interactive hook only for OpenAI API-key requests", async () => {
		const hook = hookOf(createTuiExtension(mergeConfig({ serviceTier: "flex" })));
		const ctx = (model: unknown, oauth: boolean) => ({
			model,
			hasUI: false,
			modelRegistry: { isUsingOAuth: () => oauth },
		});
		expect((await hook(ctx(openai, false))).service_tier).toBe("flex");
		expect(await hook(ctx(openai, true))).not.toHaveProperty("service_tier");
		const openrouter = { provider: "openrouter", id: "openai/gpt-6-luna", api: "openai-completions" };
		expect(await hook(ctx(openrouter, false))).not.toHaveProperty("service_tier");
		const untiered = hookOf(createTuiExtension(mergeConfig({})));
		expect(await untiered(ctx(openai, false))).not.toHaveProperty("service_tier");
	});

	it("puts the tier on a copy of the model, so requests without onPayload (compaction) send it", async () => {
		const login = await runtimeWithAuth({});
		const registryModel = login.modelRuntime.getModels("openai")[0];
		const tiered = withServiceTier(registryModel, "flex");
		expect(tiered).not.toBe(registryModel);
		expect(registryModel.samplingParams?.service_tier).toBeUndefined();
		expect(withServiceTier(registryModel, undefined)).toBe(registryModel);
		expect(withServiceTier(tiered, "flex")).toBe(tiered);

		// pi-ai's OpenAI Responses client (the copy pi uses), called the way pi's compaction calls it: no onPayload.
		const responses = pathToFileURL(
			join(process.cwd(), "node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js"),
		).href;
		const { stream } = (await import(responses)) as {
			stream: (model: unknown, context: unknown, options: unknown) => AsyncIterable<unknown>;
		};
		const bodies: Array<Record<string, unknown>> = [];
		const fetch = async (_url: unknown, init?: { body?: unknown }) => {
			bodies.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ error: { message: "stop" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		};
		const context = { messages: [{ role: "user", content: "Summarize.", timestamp: 0 }] };
		for await (const _event of stream(tiered, context, { apiKey: "sk-test", fetch, maxRetries: 0 })) {
			// drain
		}
		expect(bodies).toHaveLength(1);
		expect(bodies[0].service_tier).toBe("flex");
	});

	it("leaves other payloads as they are", () => {
		const body: Record<string, unknown> = { service_tier: "flex" };
		expect(applyServiceTier(body, "flex")).toBe(false);
		expect(applyServiceTier(body, undefined)).toBe(false);
		expect(applyServiceTier("data", "flex")).toBe(false);
		expect(applyServiceTier(body, "priority")).toBe(true);
		expect(body.service_tier).toBe("priority");
	});

	it("waits longer between retries under flex and retries its capacity errors", () => {
		const standard = [15_000, 30_000];
		expect(retryDelaysFor("flex", standard)).toEqual([60_000, 120_000, 300_000, 600_000, 900_000]);
		expect(retryDelaysFor("flex", standard)).toBe(FLEX_RETRY_DELAYS);
		expect(retryDelaysFor("priority", standard)).toBe(standard);
		expect(retryDelaysFor(undefined, standard)).toBe(standard);
		// pi formats OpenAI API errors as "OpenAI API error (<status>): <body>".
		expect(
			classifyProviderError(
				'OpenAI API error (429): {"message":"Resource Unavailable","type":"resource_unavailable","param":null,"code":"resource_unavailable"}',
			),
		).toBe("transient");
		expect(classifyProviderError("429 Resource Unavailable")).toBe("transient");
		expect(classifyProviderError("Resource Unavailable")).toBe("transient");
		expect(classifyProviderError("Request timed out.")).toBe("transient");
	});
});
