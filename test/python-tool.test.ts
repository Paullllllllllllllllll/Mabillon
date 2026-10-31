import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { clearShown, type PythonRunner, type PythonRunRequest, shownFiles } from "../src/agent/python-tool.ts";
import type { DocState } from "../src/agent/state.ts";
import { type ChronoConfig, checkToolSet, effectiveTools, mergeConfig } from "../src/config.ts";
import { run } from "../src/driver.ts";
import { call, createFauxRuntime, makeImageFolder, messageText, say, tempDir } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const UNIT_FILE = [
	"---",
	"image_analysis: |",
	"  Single column of roman type.",
	"no_transcribable_text: false",
	"transcription_not_possible: false",
	"---",
	"To make a Tart of Hearbs.",
].join("\n");

/** What the interpreter probe prints: executable, sys.prefix, sys.base_prefix. */
const PROBE_OK = { exitCode: 0, stdout: '["/py/bin/python", "/py", "/py"]\n', stderr: "", timedOut: false };

function currentUnit(context: TranscriptContext): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const match = /Current unit: (p\d+)/.exec(messageText(message));
		if (match) return match[1];
	}
	return undefined;
}

/** The agent calls python once per page with `code`, then writes and commits the page. */
function pythonResponder(code: string, results: string[], images: number[]) {
	return (context: TranscriptContext) => {
		const last = context.messages[context.messages.length - 1];
		const unit = currentUnit(context);
		if (last.role === "user") return unit ? call("python", { code }) : say("Nothing to do.");
		if (last.role === "toolResult") {
			if (last.toolName === "python") {
				results.push(messageText(last));
				images.push(last.content.filter((block) => block.type === "image").length);
				return call("write", { path: `units/${unit}.md`, content: UNIT_FILE });
			}
			if (last.toolName === "write") return call("verify", { final: true });
			if (last.toolName === "verify") return say("Done.");
		}
		return say("ok");
	};
}

async function runWith(
	responder: Parameters<typeof createFauxRuntime>[0],
	overrides: Partial<ChronoConfig>,
	pythonRunner?: PythonRunner,
) {
	const faux = await createFauxRuntime(responder);
	cleanups.push(faux.cleanup);
	const root = tempDir();
	const folder = await makeImageFolder(join(root, "book"), 2);
	const config = mergeConfig({ model: "faux/faux-1", out: join(root, "out"), python: true, ...overrides });
	const summary = await run({
		mode: "transcribe",
		inputs: [folder],
		config,
		log: () => {},
		services: { modelRuntime: faux.modelRuntime, agentDir: faux.agentDir, settings: {}, pythonRunner },
	});
	return { summary, workDir: join(root, "out", "book", "work"), runDir: join(root, "out", "book", "run") };
}

function hasPython(): boolean {
	const result = spawnSync("python", ["-c", "import numpy, PIL"], { windowsHide: true, timeout: 60_000 });
	return result.status === 0;
}

describe("python tool", () => {
	it("is opt-in and only for image units", () => {
		const images = { mode: "transcribe" as const, inputKind: "images" as const, entries: false };
		expect(effectiveTools({}, images)).not.toContain("python");
		expect(effectiveTools({ python: true }, images)).toContain("python");
		expect(effectiveTools({ python: true }, { ...images, inputKind: "text" })).not.toContain("python");
	});

	it("can replace view as the way to look at image units", () => {
		const where = { mode: "transcribe" as const, inputKind: "images" as const };
		expect(() => checkToolSet(["read", "write", "python", "verify"], where)).not.toThrow();
		expect(() => checkToolSet(["read", "write", "verify"], where)).toThrow(/view \(or python\) cannot be left out/);
	});

	it("materializes the pages, passes no user environment and shows the saved images", async () => {
		const requests: PythonRunRequest[] = [];
		const runner: PythonRunner = async (request) => {
			requests.push(request);
			if (request.args[0] === "-c") return PROBE_OK;
			await sharp({ create: { width: 300, height: 80, channels: 3, background: "#ffffff" } })
				.png()
				.toFile(join(request.cwd, "scratch", "show", "b.png"));
			await sharp({ create: { width: 200, height: 50, channels: 3, background: "#eeeeee" } })
				.png()
				.toFile(join(request.cwd, "scratch", "show", "a.png"));
			return { exitCode: 0, stdout: "measured 12 lines\n", stderr: "", timedOut: false };
		};
		process.env.MABILLON_TEST_SECRET = "sk-should-not-leak";
		const results: string[] = [];
		const images: number[] = [];
		const { summary, workDir, runDir } = await runWith(pythonResponder("print('hi')", results, images), {}, runner);
		delete process.env.MABILLON_TEST_SECRET;

		expect(summary.documents[0].committed).toBe(2);
		const calls = requests.filter((request) => request.args[0] !== "-c");
		expect(calls).toHaveLength(2);
		expect(calls[0].env.MABILLON_PAGE).toBe("source/p0001.png");
		expect(calls[0].env.MABILLON_NEXT_PAGE).toBe("source/p0002.png");
		expect(calls[1].env.MABILLON_PREVIOUS_PAGE).toBe("source/p0001.png");
		expect(Object.values(calls[0].env)).not.toContain("sk-should-not-leak");
		expect(readFileSync(join(workDir, "scratch", "_call.py"), "utf8")).toBe("print('hi')");
		expect(existsSync(join(workDir, "scratch", "pagetools.py"))).toBe(true);
		const page = await sharp(join(workDir, "source", "p0001.png")).metadata();
		expect([page.width, page.height]).toEqual([800, 1100]);
		expect(results[0]).toMatch(/Exit code 0\.\nstdout:\nmeasured 12 lines/);
		// Name order, so the agent controls the order of its images.
		expect(results[0].indexOf("scratch/show/a.png")).toBeLessThan(results[0].indexOf("scratch/show/b.png"));
		expect(images).toEqual([2, 2]);
		const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as DocState;
		expect(state.experiment?.tools).toContain("python");
		expect(state.experiment?.settings.pythonHelperSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it("reports a failing script and the time limit as errors", async () => {
		const runner: PythonRunner = async (request) =>
			request.args[0] === "-c"
				? PROBE_OK
				: { exitCode: null, stdout: "", stderr: "Traceback: boom", timedOut: true };
		const results: string[] = [];
		const { summary } = await runWith(pythonResponder("while True: pass", results, []), { pythonTimeout: 5 }, runner);
		expect(summary.documents[0].committed).toBe(2);
		expect(results[0]).toMatch(/Stopped after 5 s \(time limit\)\.\nstderr:\nTraceback: boom/);
	});

	it("stops before any document when the interpreter lacks numpy or Pillow", async () => {
		const runner: PythonRunner = async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "ModuleNotFoundError: No module named 'numpy'",
			timedOut: false,
		});
		await expect(runWith(() => say("never"), {}, runner)).rejects.toThrow(/cannot import numpy and Pillow/);
	});

	it("refuses a scratch/show that is a link instead of following it", () => {
		const workDir = tempDir();
		const outside = tempDir();
		writeFileSync(join(outside, "keep.png"), "not an image");
		mkdirSync(join(workDir, "scratch"));
		// A junction needs no privilege on Windows; elsewhere a directory symlink.
		symlinkSync(outside, join(workDir, "scratch", "show"), process.platform === "win32" ? "junction" : "dir");
		expect(() => clearShown(workDir)).toThrow(/scratch\/show must be a plain folder/);
		expect(() => shownFiles(workDir)).toThrow(/scratch\/show must be a plain folder/);
		expect(existsSync(join(outside, "keep.png"))).toBe(true);
	});

	it("shows only plain files in scratch/show", () => {
		const workDir = tempDir();
		const outside = tempDir();
		writeFileSync(join(outside, "secret.png"), "x");
		mkdirSync(join(workDir, "scratch", "show"), { recursive: true });
		writeFileSync(join(workDir, "scratch", "show", "own.png"), "x");
		linkSync(join(outside, "secret.png"), join(workDir, "scratch", "show", "hard.png"));
		expect(shownFiles(workDir)).toEqual(["own.png"]);
		clearShown(workDir);
		expect(existsSync(join(outside, "secret.png"))).toBe(true);
	});

	it("stops before any document when the interpreter does not exist", async () => {
		await expect(runWith(() => say("never"), { pythonPath: join(tempDir(), "no-python.exe") })).rejects.toThrow(
			/could not be started|cannot import numpy and Pillow/,
		);
	});

	it.skipIf(!hasPython())("runs pagetools on the page with the local interpreter", async () => {
		const code = [
			"import pagetools as pt",
			"img = pt.page()",
			"print('size', img.size)",
			"pt.show(pt.zoom(pt.crop(img, (0, 0, 0.5, 0.3)), 2), 'top')",
		].join("\n");
		const results: string[] = [];
		const images: number[] = [];
		const { summary } = await runWith(pythonResponder(code, results, images), { pythonSandbox: false });
		expect(summary.documents[0].committed).toBe(2);
		expect(results[0]).toMatch(/size \(800, 1100\)/);
		expect(results[0]).toMatch(/scratch\/show\/top\.png: 800x660 px/);
		expect(images[0]).toBe(1);
	});
});
