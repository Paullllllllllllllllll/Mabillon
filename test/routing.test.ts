import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createChronoExtension } from "../src/agent/extension.ts";
import type { SessionRuntime } from "../src/agent/runtime.ts";
import { type DocState, docPaths } from "../src/agent/state.ts";
import { parseArgs } from "../src/cli.ts";
import { coerceConfigValue, loadConfigFile, mergeConfig } from "../src/config.ts";
import { classifyProviderError, isImageRequestError, run } from "../src/driver.ts";
import { resolveImageProfile } from "../src/inputs/image-profile.ts";
import {
	applyOpenRouterPreferences,
	describePreferences,
	effectiveRouting,
	isOpenRouter,
	openRouterPreferences,
	servingProvider,
	withOpenRouterRouting,
} from "../src/routing.ts";
import { resolveSchema } from "../src/schemas/registry.ts";
import { call, loadRegisterFauxProvider, makeImageFolder, messageText, say, tempDir } from "./helpers.ts";

const openrouter = { provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" };

describe("OpenRouter routing", () => {
	it("asks for zero data retention by default, for OpenRouter models only", () => {
		const config = mergeConfig({});
		expect(config.zdr).toBe(true);
		expect(openRouterPreferences(config, openrouter)).toEqual({ zdr: true, data_collection: "deny" });
		expect(openRouterPreferences(config, { provider: "anthropic" })).toBeUndefined();
		expect(openRouterPreferences(config, undefined)).toBeUndefined();
		// A custom provider pointing at OpenRouter counts as well.
		expect(isOpenRouter({ provider: "my-router", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
		expect(isOpenRouter({ provider: "together", baseUrl: "https://api.together.xyz/v1" })).toBe(false);
		expect(openRouterPreferences(mergeConfig({ zdr: false }), openrouter)).toEqual({});
	});

	it("pins providers without fallback and filters quantizations", () => {
		const config = mergeConfig({ openrouterProviders: ["deepinfra", "together"], openrouterQuantizations: ["fp8"] });
		const preferences = openRouterPreferences(config, openrouter);
		expect(preferences).toEqual({
			zdr: true,
			data_collection: "deny",
			order: ["deepinfra", "together"],
			allow_fallbacks: false,
			quantizations: ["fp8"],
		});
		expect(describePreferences(preferences)).toBe(
			"OpenRouter: zero data retention; providers deepinfra, together (no fallback); quantizations fp8",
		);
	});

	it("merges the preferences over routing from models.json", () => {
		const payload: Record<string, unknown> = { model: "qwen/qwen3.8-27b", provider: { sort: "price", zdr: false } };
		expect(applyOpenRouterPreferences(payload, { zdr: true, data_collection: "deny" })).toBe(true);
		expect(payload.provider).toEqual({ sort: "price", zdr: true, data_collection: "deny" });
		expect(applyOpenRouterPreferences(payload, { zdr: true, data_collection: "deny" })).toBe(false);
		const plain: Record<string, unknown> = { model: "x" };
		expect(applyOpenRouterPreferences(plain, {})).toBe(false);
		expect(plain).not.toHaveProperty("provider");
		expect(applyOpenRouterPreferences(plain, undefined)).toBe(false);
	});

	it("reads the serving provider from stream chunks", () => {
		expect(servingProvider({ id: "gen-1", provider: "DeepInfra", choices: [] })).toBe("DeepInfra");
		expect(servingProvider({ id: "chatcmpl-1", choices: [] })).toBeUndefined();
		expect(servingProvider("data")).toBeUndefined();
	});

	it("parses the settings from the command line and the yaml file", () => {
		const parsed = parseArgs([
			"transcribe",
			"book.pdf",
			"--no-zdr",
			"--openrouter-providers",
			"deepinfra, together",
			"--openrouter-quantizations=FP8,bf16",
		]);
		expect(parsed.overrides).toMatchObject({
			zdr: false,
			openrouterProviders: ["deepinfra", "together"],
			openrouterQuantizations: ["fp8", "bf16"],
		});
		expect(() => coerceConfigValue("openrouterQuantizations", "fp8,q4_k_m", ".")).toThrow(/unknown level q4_k_m/);
		const dir = tempDir();
		const file = join(dir, "mabillon.yaml");
		writeFileSync(file, "zdr: false\nopenrouter_providers:\n  - deepinfra\nopenrouter_quantizations: fp8\n");
		expect(loadConfigFile(file)).toEqual({
			zdr: false,
			openrouterProviders: ["deepinfra"],
			openrouterQuantizations: ["fp8"],
		});
		// The command line replaces the file's providers rather than adding to them.
		expect(mergeConfig(loadConfigFile(file), { openrouterProviders: ["together"] }).openrouterProviders).toEqual([
			"together",
		]);
	});

	it("stops the run when no endpoint meets the routing settings, and treats oversized requests as image errors", () => {
		expect(classifyProviderError("404 No endpoints found matching your data policy (Zero data retention)")).toBe(
			"routing",
		);
		expect(classifyProviderError("No allowed providers are available for the selected model.")).toBe("routing");
		expect(classifyProviderError("404 No endpoints found for qwen/qwen3.8-27b.")).toBe("routing");
		expect(classifyProviderError("429 Too Many Requests")).toBe("transient");
		expect(isImageRequestError("413 Payload Too Large")).toBe(true);
		expect(isImageRequestError("Request Entity Too Large")).toBe(true);
		expect(isImageRequestError("No endpoints found matching your data policy")).toBe(false);
	});

	it("sends the preferences with each request and records the serving providers", async () => {
		const schema = resolveSchema(undefined, "transcribe", []);
		const units = [{ id: "p0001", index: 1, status: "pending" as const }];
		const runtime = {
			workDir: tempDir(),
			paths: docPaths(tempDir()),
			mode: "transcribe",
			inputKind: "images",
			schema,
			config: mergeConfig({}),
			state: { units, stem: "x" },
			batch: units,
			tools: new Set(["read", "write", "edit", "view", "verify"]),
			documentLabel: "x",
			contextImages: [],
			imageProfile: resolveImageProfile(
				{ provider: "openrouter", id: "qwen/qwen3.8-27b", api: "openai-completions" },
				"max",
			),
			routing: openRouterPreferences(mergeConfig({}), openrouter),
			servedBy: new Set<string>(),
			sources: { image: () => undefined, text: () => "", materialize: () => undefined },
			persist: () => undefined,
			log: () => undefined,
		} as unknown as SessionRuntime;
		const handlers = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
		const pi = {
			on: (name: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(name, handler),
			registerTool: () => undefined,
			sendMessage: () => undefined,
		};
		createChronoExtension(runtime).factory(pi as never);

		const payload = { model: "qwen/qwen3.8-27b", messages: [] };
		await handlers.get("before_provider_request")?.({ type: "before_provider_request", payload });
		expect(payload).toMatchObject({ provider: { zdr: true, data_collection: "deny" } });

		const chunk = (provider: string) => ({
			type: "provider_stream_event",
			provider: "openrouter",
			api: "openai-completions",
			model: "qwen/qwen3.8-27b",
			data: { id: "gen-1", provider, choices: [] },
		});
		await handlers.get("provider_stream_event")?.(chunk("DeepInfra"));
		await handlers.get("provider_stream_event")?.(chunk("DeepInfra"));
		await handlers.get("provider_stream_event")?.(chunk("Together"));
		expect([...(runtime.servedBy ?? [])]).toEqual(["DeepInfra", "Together"]);

		// Models outside OpenRouter: requests stay as they are.
		runtime.routing = undefined;
		const other = { model: "claude-opus-5-5", messages: [] };
		await handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: other });
		expect(other).not.toHaveProperty("provider");
	});

	it("puts the routing on a copy of the model, so requests without onPayload (compaction) send it", async () => {
		const registryModel = {
			id: "qwen/qwen3.8-27b",
			name: "Qwen",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1_000,
			compat: { openRouterRouting: { quantizations: ["int4"], zdr: true, sort: "price" } },
		};
		const preferences = openRouterPreferences(
			mergeConfig({ zdr: false, openrouterQuantizations: ["fp8"] }),
			registryModel,
		);
		const routed = withOpenRouterRouting(registryModel, preferences);
		expect(routed).not.toBe(registryModel);
		// Mabillon's settings win on shared keys; --no-zdr keeps an inherited zdr.
		const expected = { quantizations: ["fp8"], zdr: true, sort: "price" };
		expect(routed.compat.openRouterRouting).toEqual(expected);
		expect(effectiveRouting(registryModel, preferences)).toEqual(expected);
		expect(registryModel.compat.openRouterRouting).toEqual({ quantizations: ["int4"], zdr: true, sort: "price" });
		// Other providers and empty preferences leave the model object as it is.
		const openai = { provider: "openai", id: "gpt-6-luna", api: "openai-responses" };
		expect(withOpenRouterRouting(openai, openRouterPreferences(mergeConfig({}), openai))).toBe(openai);
		expect(withOpenRouterRouting(registryModel, {})).toBe(registryModel);
		expect(withOpenRouterRouting(routed, preferences)).toBe(routed);

		// pi-ai's chat completions client (the copy pi uses), called the way pi's compaction calls it: no onPayload.
		const completions = pathToFileURL(
			join(
				process.cwd(),
				"node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
			),
		).href;
		const { stream } = (await import(completions)) as {
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
		for await (const _event of stream(routed, context, { apiKey: "key", fetch, maxRetries: 0 })) {
			// drain
		}
		expect(bodies).toHaveLength(1);
		expect(bodies[0].provider).toEqual(expected);
	});

	it("runs sessions on the routed model and records the routing that was sent", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "book"), 1);
		const agentDir = tempDir("mabillon-agentdir-");
		const registerFauxProvider = await loadRegisterFauxProvider();
		const faux = registerFauxProvider({
			provider: "faux",
			models: [{ id: "qwen3.8-27b", input: ["text", "image"], contextWindow: 200_000, maxTokens: 8192 }],
		});
		const routings: unknown[] = [];
		const page = [
			"---",
			"image_analysis: |",
			"  Single column of roman type.",
			"no_transcribable_text: false",
			"transcription_not_possible: false",
			"---",
			"To make a Tart of Hearbs.",
		].join("\n");
		const step = (
			context: TranscriptContext,
			_options: unknown,
			_state: unknown,
			model: unknown,
		): AssistantMessage => {
			routings.push((model as { compat?: { openRouterRouting?: unknown } }).compat?.openRouterRouting);
			const last = context.messages[context.messages.length - 1];
			if (last.role === "user" && /Current unit: p0001/.test(messageText(last))) {
				return call("write", { path: "units/p0001.md", content: page });
			}
			if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
			return say("Done.");
		};
		faux.setResponses(Array.from({ length: 50 }, () => step));
		try {
			const modelRuntime = await ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			});
			// An OpenRouter endpoint (by its base URL) whose models.json entry has routing of its own.
			modelRuntime.registerProvider("my-router", {
				baseUrl: "https://openrouter.ai/api/v1",
				apiKey: "key",
				api: faux.api,
				models: faux.models.map((model) => ({
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					compat: { openRouterRouting: { quantizations: ["int4"], zdr: true } },
				})),
			});
			const config = mergeConfig({
				model: "my-router/qwen3.8-27b",
				zdr: false,
				openrouterProviders: ["deepinfra"],
				out: join(root, "out"),
			});
			const summary = await run({
				mode: "transcribe",
				inputs: [folder],
				config,
				log: () => undefined,
				services: { modelRuntime, agentDir, settings: {} },
			});
			expect(summary.documents[0].committed).toBe(1);
			expect(routings.length).toBeGreaterThan(0);
			const sent = { quantizations: ["int4"], zdr: true, order: ["deepinfra"], allow_fallbacks: false };
			for (const routing of routings) expect(routing).toEqual(sent);
			// The registry's model is not changed.
			expect(
				(modelRuntime.getModel("my-router", "qwen3.8-27b")?.compat as { openRouterRouting?: unknown })
					.openRouterRouting,
			).toEqual({ quantizations: ["int4"], zdr: true });
			const state = JSON.parse(readFileSync(join(root, "out", "book", "run", "state.json"), "utf8")) as DocState;
			expect(state.sessions[0].routing).toEqual(sent);
		} finally {
			faux.unregister();
		}
	}, 60_000);
});
