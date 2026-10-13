import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import sharp from "sharp";
import {
	fileLoader,
	type ImageLimits,
	type ImageLoader,
	loadRaw,
	type PreparedImage,
	prepareImage,
} from "../inputs/images.ts";
import { getPackageRoot, sha256 } from "../util.ts";

/** Images a python call can show; more files in scratch/show/ are listed but not attached. */
export const MAX_SHOWN_IMAGES = 4;
/** Characters of stdout and of stderr returned to the model (the end of each stream). */
const OUTPUT_LIMIT = 6000;
/** Bytes of each stream kept while the script runs. */
const CAPTURE_LIMIT = 1_000_000;
const SHOW_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"]);

export const HELPER_NAME = "pagetools.py";
/** The script of the current call, inside scratch/ so that `import pagetools` finds the helper beside it. */
export const CALL_SCRIPT = "scratch/_call.py";
export const SHOW_DIR = "scratch/show";

export interface PythonRun {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface PythonRunRequest {
	python: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	timeoutMs: number;
	signal?: AbortSignal;
}

/** Runs the interpreter; the sandboxed runner wraps the same request. */
export type PythonRunner = (request: PythonRunRequest) => Promise<PythonRun>;

/** The helper module bundled with Mabillon (python/pagetools.py). */
export function bundledHelperPath(): string {
	return join(getPackageRoot(), "python", HELPER_NAME);
}

export function bundledHelperSha256(): string {
	return sha256(readFileSync(bundledHelperPath()));
}

/**
 * Make sure `rel` (inside workDir) and every folder above it are plain folders, creating missing ones. The script
 * can write scratch/, so it could replace a folder there with a link or junction that sends Mabillon's own reads,
 * writes and deletions elsewhere; such a folder is refused instead of followed.
 */
export function plainDir(workDir: string, rel: string): string {
	let path = workDir;
	for (const part of rel.split("/")) {
		path = join(path, part);
		if (!existsSync(path) && !isLink(path)) {
			mkdirSync(path);
			continue;
		}
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(
				`${relative(workDir, path).split(sep).join("/")} must be a plain folder, not a link or a file`,
			);
		}
	}
	return path;
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Copy the helper into scratch/ unless the agent's own version is already there (its edits persist). */
export function installHelper(workDir: string): void {
	const target = join(plainDir(workDir, "scratch"), HELPER_NAME);
	if (existsSync(target) || isLink(target)) return;
	copyFileSync(bundledHelperPath(), target);
}

/**
 * The environment of a python call: no variables of the user's (API keys, tokens) are passed on, only what the
 * interpreter needs, UTF-8 streams and files, and the paths of the pages.
 */
export function pythonEnvironment(
	workDir: string,
	pages: { current: string; previous?: string; next?: string },
	base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {
		PYTHONUTF8: "1",
		PYTHONIOENCODING: "utf-8",
		PYTHONDONTWRITEBYTECODE: "1",
		PYTHONNOUSERSITE: "1",
		MPLBACKEND: "Agg",
		TEMP: join(workDir, "scratch", "tmp"),
		TMP: join(workDir, "scratch", "tmp"),
		TMPDIR: join(workDir, "scratch", "tmp"),
		MABILLON_PAGE: pages.current,
		...(pages.previous ? { MABILLON_PREVIOUS_PAGE: pages.previous } : {}),
		...(pages.next ? { MABILLON_NEXT_PAGE: pages.next } : {}),
	};
	for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "LANG"]) {
		const value = base[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/**
 * Run a program and capture its output, with a time limit. The whole process tree is stopped on timeout or abort
 * (taskkill /T on Windows, the process group elsewhere).
 */
export function spawnCapture(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal },
): Promise<PythonRun> {
	return new Promise((resolvePromise, reject) => {
		const windows = process.platform === "win32";
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
			detached: !windows,
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			if (outBytes < CAPTURE_LIMIT) out.push(chunk);
			outBytes += chunk.length;
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (errBytes < CAPTURE_LIMIT) err.push(chunk);
			errBytes += chunk.length;
		});
		let timedOut = false;
		const stop = () => {
			if (child.pid === undefined) return;
			if (windows) {
				spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
				return;
			}
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeoutMs);
		const onAbort = () => stop();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};
		child.on("error", (error) => {
			finish();
			reject(error);
		});
		child.on("close", (code) => {
			finish();
			resolvePromise({
				exitCode: code,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
				timedOut,
			});
		});
	});
}

/** Runs the interpreter as the user, without a sandbox (--no-python-sandbox). */
export const localPythonRunner: PythonRunner = (request) => spawnCapture(request.python, request.args, request);

/** Write a page as lossless PNG at the resolution the view tool cuts its regions from. */
export async function materializePage(target: string, key: string, loader: ImageLoader): Promise<void> {
	if (existsSync(target)) return;
	const raw = await loadRaw(key, loader);
	mkdirSync(dirname(target), { recursive: true });
	const temp = `${target}.tmp`;
	await sharp(raw.data, {
		limitInputPixels: false,
		raw: { width: raw.width, height: raw.height, channels: raw.channels },
	})
		.png({ compressionLevel: 3 })
		.toFile(temp);
	// A rename keeps a half-written file from ever being read as the page.
	renameSync(temp, target);
}

/** Remove the images of the previous call from scratch/show/ (plain files only; links are removed, not followed). */
export function clearShown(workDir: string): void {
	const dir = plainDir(workDir, SHOW_DIR);
	for (const name of readdirSync(dir)) {
		if (!SHOW_EXTENSIONS.has(extname(name).toLowerCase())) continue;
		const stat = lstatSync(join(dir, name));
		if (stat.isFile() || stat.isSymbolicLink()) unlinkSync(join(dir, name));
	}
}

/** Images the call saved to scratch/show/ as plain files, in name order. */
export function shownFiles(workDir: string): string[] {
	const dir = plainDir(workDir, SHOW_DIR);
	const root = realpathSync(dir);
	return readdirSync(dir)
		.filter((name) => SHOW_EXTENSIONS.has(extname(name).toLowerCase()))
		.filter((name) => {
			const path = join(dir, name);
			const stat = lstatSync(path);
			// Hard links and links to files elsewhere are not read: the file must be a single plain file here.
			return stat.isFile() && stat.nlink === 1 && dirname(realpathSync(path)) === root;
		})
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** An image the script saved, sized for the model (never enlarged: the script chose its scale). */
export async function prepareShown(path: string, limits: ImageLimits): Promise<PreparedImage> {
	const stat = lstatSync(path);
	return prepareImage(`show:${path}:${stat.mtimeMs}:${stat.size}`, fileLoader(path), { limits });
}

export function describeShown(name: string, image: PreparedImage): string {
	const scale = Math.max(image.contentWidth, image.contentHeight) / Math.max(1, image.sourceWidth, image.sourceHeight);
	const note = scale < 0.95 ? `; downscaled to ${Math.round(scale * 100)}% for the model` : "";
	const padded =
		image.contentWidth !== image.width || image.contentHeight !== image.height
			? ` (padded with white to ${image.width}x${image.height} px)`
			: "";
	return `${SHOW_DIR}/${name}: ${image.sourceWidth}x${image.sourceHeight} px, shown at ${image.contentWidth}x${image.contentHeight} px${padded}${note}.`;
}

/** The end of a stream, marked when cut. */
export function tail(text: string, limit = OUTPUT_LIMIT): string {
	const trimmed = text.replace(/\s+$/, "");
	if (trimmed.length <= limit) return trimmed;
	return `[... ${trimmed.length - limit} earlier characters cut]\n${trimmed.slice(-limit)}`;
}
