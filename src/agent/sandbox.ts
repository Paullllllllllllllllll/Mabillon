/**
 * OS-level sandbox for the python tool. Forked from pi's example sandbox extension
 * (@earendil-works/pi-coding-agent examples/extensions/sandbox) and moved to @anthropic-ai/sandbox-runtime
 * 0.0.79, which adds Windows. Unlike the example, it never falls back to an unsandboxed run, starts the interpreter
 * without a shell (wrapWithSandboxArgv), allows no network at all, and grants one document's work folder at a time.
 *
 * Windows needs a one-time elevated `npx @anthropic-ai/sandbox-runtime@0.0.79 windows-install`, which creates the
 * `srt-sandbox` account the interpreter then runs as, with a WFP filter that blocks its outbound connections.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig, VENDORED_SRT_WIN_EXE } from "@anthropic-ai/sandbox-runtime";
import { type PythonRun, type PythonRunner, type PythonRunRequest, spawnCapture } from "./python-tool.ts";

/** What the sandboxed interpreter may touch: read the work folder and the interpreter, write only scratch/. */
export function sandboxConfig(workDir: string, interpreterDirs: string[]): SandboxRuntimeConfig {
	const readable = [workDir, ...interpreterDirs];
	return {
		network: { allowedDomains: [], deniedDomains: [] },
		filesystem: {
			// Windows: the sandbox account has no rights on the user's files to begin with, so the grants are the
			// allowlist. macOS and Linux read everything unless denied: the home folder is denied, minus the grants.
			denyRead: process.platform === "win32" ? [] : [homedir()],
			allowRead: readable,
			allowWrite: [join(workDir, "scratch")],
			denyWrite: [],
		},
		// The broker binary shipped with the package; no grant covers Mabillon's own folder, so no script can replace it.
		...(process.platform === "win32" ? { windows: { srtWin: { path: VENDORED_SRT_WIN_EXE } } } : {}),
	};
}

let initialized: string | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** One sandboxed call at a time in this process: on Windows the grants hold for the whole sandbox session. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
	const next = queue.then(task, task);
	queue = next.catch(() => undefined);
	return next;
}

async function ensureSandbox(config: SandboxRuntimeConfig): Promise<void> {
	const key = JSON.stringify(config);
	if (key === initialized) return;
	if (initialized !== undefined) {
		initialized = undefined;
		await SandboxManager.reset();
	}
	if (!SandboxManager.isSupportedPlatform()) {
		throw new Error(`the sandbox does not support ${process.platform}`);
	}
	await SandboxManager.initialize(config);
	initialized = key;
}

/** Remove the sandbox's grants and stop its proxies (at the end of a run). */
export async function resetSandbox(): Promise<void> {
	await serialized(async () => {
		if (initialized === undefined) return;
		initialized = undefined;
		await SandboxManager.reset();
	});
}

/** Arguments are passed without a shell; anything that would need quoting is refused rather than quoted. */
function plainArgument(arg: string): string {
	if (!/^[\w./:\\=-]+$/.test(arg)) throw new Error(`sandboxed python argument needs quoting: ${arg}`);
	return arg;
}

/** The environment of the child: Mabillon's minimal environment plus what the sandbox adds (its proxy settings). */
function childEnv(request: PythonRunRequest, sandboxEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const added: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(sandboxEnv)) {
		if (value !== undefined && process.env[key] !== value) added[key] = value;
	}
	return { ...request.env, ...added };
}

/**
 * A runner that starts the interpreter (an absolute path) in the sandbox. `interpreterDirs` are the folders the
 * interpreter needs to read (its sys.prefix and sys.base_prefix).
 */
export function sandboxedPythonRunner(interpreterDirs: string[]): PythonRunner {
	return (request) =>
		serialized(async (): Promise<PythonRun> => {
			await ensureSandbox(sandboxConfig(request.cwd, interpreterDirs));
			const args = request.args.map(plainArgument);
			const windows = process.platform === "win32";
			// Windows: the interpreter is the "shell" and the arguments its command line; elsewhere one command string.
			const { argv, env } = windows
				? await SandboxManager.wrapWithSandboxArgv(
						args.join(" "),
						{ exe: request.python, args: [] },
						undefined,
						request.signal,
						request.cwd,
					)
				: await SandboxManager.wrapWithSandboxArgv(
						[plainArgument(request.python), ...args].join(" "),
						undefined,
						undefined,
						request.signal,
						request.cwd,
					);
			try {
				return await spawnCapture(argv[0], argv.slice(1), {
					cwd: request.cwd,
					env: childEnv(request, env),
					timeoutMs: request.timeoutMs,
					signal: request.signal,
				});
			} finally {
				SandboxManager.cleanupAfterCommand();
			}
		});
}

/**
 * Before any document: run a probe in the sandbox, in a temporary work folder. It must import numpy and Pillow,
 * write to scratch/, fail to write outside it, and fail to open a network connection. Throws with the reason.
 */
export async function checkSandbox(python: string, interpreterDirs: string[]): Promise<void> {
	const workDir = mkdtempSync(join(tmpdir(), "mabillon-sandbox-check-"));
	try {
		mkdirSync(join(workDir, "scratch"), { recursive: true });
		const probe = [
			"import socket, numpy, PIL",
			"from pathlib import Path",
			"Path('scratch/written.txt').write_text('ok', encoding='utf-8')",
			"try:",
			"    Path('outside.txt').write_text('x', encoding='utf-8')",
			"    print('WRITE-OUTSIDE')",
			"except OSError:",
			"    pass",
			"try:",
			"    socket.create_connection(('1.1.1.1', 443), timeout=5).close()",
			"    print('NETWORK')",
			"except OSError:",
			"    pass",
			"print('PROBE-DONE')",
		].join("\n");
		writeFileSync(join(workDir, "scratch", "probe.py"), probe, "utf8");
		const run = await sandboxedPythonRunner(interpreterDirs)({
			python,
			args: ["-X", "utf8", "scratch/probe.py"],
			cwd: workDir,
			env: { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
			timeoutMs: 120_000,
		});
		const problems: string[] = [];
		if (!run.stdout.includes("PROBE-DONE")) {
			problems.push(
				`the probe did not finish (exit code ${run.exitCode}): ${(run.stderr || run.stdout).trim().slice(-400)}`,
			);
		}
		if (run.stdout.includes("WRITE-OUTSIDE")) problems.push("the probe could write outside scratch/");
		if (run.stdout.includes("NETWORK")) problems.push("the probe could open a network connection");
		let written = "";
		try {
			written = readFileSync(join(workDir, "scratch", "written.txt"), "utf8");
		} catch {
			// reported below
		}
		if (run.stdout.includes("PROBE-DONE") && written !== "ok") problems.push("the probe could not write to scratch/");
		if (problems.length > 0) throw new Error(problems.join("; "));
	} finally {
		await resetSandbox();
		rmSync(workDir, { recursive: true, force: true });
	}
}
