import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli.ts";
import { call, loadRegisterFauxProvider, makeImageFolder, messageText, say, tempDir } from "./helpers.ts";

async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
	let stdout = "";
	const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	});
	try {
		const code = await cli(args);
		return { code, stdout };
	} finally {
		spy.mockRestore();
	}
}

describe("headless CLI", () => {
	const previousEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	let unregister: (() => void) | undefined;

	beforeAll(async () => {
		const agentDir = tempDir("mabillon-cli-agent-");
		const registerFauxProvider = await loadRegisterFauxProvider();
		const faux = registerFauxProvider({ provider: "fauxcli", models: [{ id: "faux-1", input: ["text", "image"] }] });
		unregister = () => faux.unregister();
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			let unit: string | undefined;
			for (let i = context.messages.length - 1; i >= 0 && !unit; i--) {
				if (context.messages[i].role === "user")
					unit = /Current unit: (p\d+)/.exec(messageText(context.messages[i]))?.[1];
			}
			if (last.role === "user" && unit) {
				return call("write", {
					path: `units/${unit}.md`,
					content: `---\nimage_analysis: one column\nno_transcribable_text: false\ntranscription_not_possible: false\n---\nPage ${unit}`,
				});
			}
			if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
			return say("done");
		};
		faux.setResponses(Array.from({ length: 200 }, () => responder));
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					fauxcli: {
						baseUrl: faux.models[0].baseUrl,
						api: faux.api,
						apiKey: "faux-key",
						models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OFFLINE = "1";
	});

	afterAll(() => {
		unregister?.();
		if (previousEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousEnv.agentDir;
		if (previousEnv.offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousEnv.offline;
	});

	it("runs a transcription with --json and reports status and verification as JSON", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "letters"), 2);
		const out = join(root, "out");
		const result = await runCli([
			"transcribe",
			folder,
			"--model",
			"fauxcli/faux-1",
			"--json",
			"--quiet",
			"--out",
			out,
		]);
		expect(result.code).toBe(0);
		const summary = JSON.parse(result.stdout);
		expect(summary).toMatchObject({ ok: true, exit_code: 0, mode: "transcribe" });
		expect(summary.documents[0]).toMatchObject({ stem: "letters", status: "complete", units_committed: 2 });
		const outputs = summary.documents[0].outputs;
		expect(outputs.sidecar).toMatch(/[\\/]letters-[0-9a-f]{8}[\\/]letters\.mabillon\.json$/);
		expect(outputs.txt).toBe(outputs.sidecar.replace(/\.mabillon\.json$/, ".txt"));
		// txt alone by default, as ChronoTranscriber renders it.
		expect(outputs.md).toBeUndefined();
		expect(outputs.store).toBe(join(out, "chronotranscriber.sqlite"));

		const status = await runCli(["status", out, "--json"]);
		expect(status.code).toBe(0);
		expect(JSON.parse(status.stdout).documents[0]).toMatchObject({ complete: true, units_committed: 2 });

		const verify = await runCli(["verify", outputs.sidecar, "--json"]);
		expect(JSON.parse(verify.stdout)).toMatchObject({ ok: true, errors: 0 });
	}, 120_000);

	it("reports configuration errors as JSON with exit code 2", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 1);
		const result = await runCli(["extract", folder, "--json", "--quiet", "--model", "fauxcli/faux-1"]);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exit_code: 2 });
		expect(JSON.parse(result.stdout).error).toMatch(/needs a schema/);
		const unknown = await runCli(["transcribe", folder, "--json", "--bogus"]);
		expect(unknown.code).toBe(2);
		expect(JSON.parse(unknown.stdout).error).toMatch(/Unknown option/);
	});

	it("refuses a service tier for a model outside OpenAI's API with exit code 2", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 1);
		const args = ["transcribe", folder, "--json", "--quiet", "--model", "fauxcli/faux-1", "--out", join(root, "out")];
		const result = await runCli([...args, "--service-tier", "flex"]);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exit_code: 2 });
		expect(JSON.parse(result.stdout).error).toMatch(/applies only to OpenAI models used with an API key/);
		const invalid = await runCli([...args, "--service-tier", "scale"]);
		expect(invalid.code).toBe(2);
		expect(JSON.parse(invalid.stdout).error).toMatch(/serviceTier/);
	});
});
