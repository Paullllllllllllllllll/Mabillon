import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Root directory of the installed mabillon package (contains schemas/ and prompts/). */
export function getPackageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 5; i++) {
		if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "schemas"))) return dir;
		dir = dirname(dir);
	}
	throw new Error("Could not locate the mabillon package root");
}

export function readPackageVersion(): string {
	const pkg = JSON.parse(readFileSync(join(getPackageRoot(), "package.json"), "utf8")) as { version: string };
	return pkg.version;
}

let implementation: { version: string; commit?: string; dirty?: boolean } | undefined;

/**
 * The Mabillon build that produced a run: the package version, plus the git commit and whether the working tree
 * has uncommitted changes when the package directory is a git checkout.
 */
export function implementationFingerprint(): { version: string; commit?: string; dirty?: boolean } {
	if (implementation) return implementation;
	const root = getPackageRoot();
	implementation = { version: readPackageVersion() };
	if (existsSync(join(root, ".git"))) {
		const git = (args: string[]) =>
			spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true });
		const head = git(["rev-parse", "HEAD"]);
		if (head.status === 0) {
			const status = git(["status", "--porcelain", "--untracked-files=no"]);
			implementation = {
				...implementation,
				commit: head.stdout.trim(),
				...(status.status === 0 ? { dirty: status.stdout.trim() !== "" } : {}),
			};
		}
	}
	return implementation;
}

export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/**
 * A key that is equal for every spelling of the same existing file or folder: the real path (symlinks resolved, and
 * on Windows the stored case), lower-cased on file systems that ignore case (Windows, macOS by default).
 */
export function canonicalPath(path: string): string {
	let real = resolve(path);
	try {
		real = realpathSync.native(real);
	} catch {
		// not there (yet): the resolved path
	}
	return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}

/**
 * Read a file written by the agent as UTF-8: a byte order mark is dropped; `valid` is false when the bytes are not
 * UTF-8 (e.g. a script wrote cp1252), and `text` then holds a lenient decoding for reports only.
 */
export function readUtf8File(path: string): { text: string; valid: boolean } {
	let bytes: Uint8Array = readFileSync(path);
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), valid: true };
	} catch {
		return { text: new TextDecoder("utf-8").decode(bytes), valid: false };
	}
}

export function ensureDir(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

/** Write a file atomically (temp file + rename) so readers never see partial content. */
export function writeFileAtomic(path: string, content: string | Buffer): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

export function writeJson(path: string, value: unknown): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Natural sort comparator: "page2" < "page10". Names equal at that level ("a"/"A", "e"/"é", "p01"/"p1") are ordered by
 * case and accents, then by code units, so the order never depends on the input order.
 */
export function naturalCompare(a: string, b: string): number {
	const base = a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
	if (base !== 0) return base;
	const variant = a.localeCompare(b, undefined, { numeric: true, sensitivity: "variant" });
	if (variant !== 0) return variant;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Turn a file or folder name into a safe identifier for output folders. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export function safeStem(name: string): string {
	const cleaned = name
		.normalize("NFKC")
		.replace(/[\\/:*?"<>|]+/g, "_")
		.replace(/\s+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^[._]+|[._]+$/g, "");
	const stem = cleaned.length > 0 ? cleaned.slice(0, 120) : "document";
	return WINDOWS_RESERVED.test(stem) ? `${stem}_` : stem;
}

export function unitWidth(count: number): number {
	return Math.max(4, String(count).length);
}

export function formatUnitId(prefix: "p" | "c", index: number, width: number): string {
	return `${prefix}${String(index).padStart(width, "0")}`;
}

/** Parse a 1-based selection like "1-20,25,30-" into a predicate. Empty or undefined selects everything. */
export function parseSelection(spec: string | undefined): (index: number) => boolean {
	if (!spec || spec.trim() === "") return () => true;
	const ranges: Array<[number, number]> = [];
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		if (trimmed === "") continue;
		const match = /^(\d*)\s*-\s*(\d*)$/.exec(trimmed);
		if (match) {
			const start = match[1] ? Number.parseInt(match[1], 10) : 1;
			const end = match[2] ? Number.parseInt(match[2], 10) : Number.POSITIVE_INFINITY;
			if (start < 1 || end < start) throw new Error(`Invalid unit range "${trimmed}" (units are numbered from 1)`);
			ranges.push([start, end]);
		} else if (/^\d+$/.test(trimmed)) {
			const value = Number.parseInt(trimmed, 10);
			if (value < 1) throw new Error(`Invalid unit "${trimmed}" (units are numbered from 1)`);
			ranges.push([value, value]);
		} else {
			throw new Error(`Invalid unit selection "${trimmed}" (expected e.g. "1-20,25")`);
		}
	}
	if (ranges.length === 0) throw new Error(`Invalid unit selection "${spec}"`);
	return (index) => ranges.some(([start, end]) => index >= start && index <= end);
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function lastLines(text: string, count: number): string {
	const lines = text.replace(/\s+$/, "").split("\n");
	return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

export function resolvePath(base: string, path: string): string {
	return resolve(base, path);
}

function looksLikeUtf16(data: Uint8Array): "utf-16le" | "utf-16be" | undefined {
	const sample = data.subarray(0, Math.min(data.length, 4096));
	if (sample.length < 8) return undefined;
	let evenZeros = 0;
	let oddZeros = 0;
	for (let i = 0; i < sample.length; i++) {
		if (sample[i] === 0) {
			if (i % 2 === 0) evenZeros++;
			else oddZeros++;
		}
	}
	const half = sample.length / 2;
	if (oddZeros > half * 0.3 && evenZeros < half * 0.05) return "utf-16le";
	if (evenZeros > half * 0.3 && oddZeros < half * 0.05) return "utf-16be";
	return undefined;
}

/**
 * Decode text bytes: BOM-aware UTF-8/UTF-16, UTF-16 without BOM, UTF-8 with isolated invalid bytes replaced, and
 * Windows-1252 for files that are clearly not UTF-8. `warning` describes anything lossy or guessed.
 */
/** Windows-1252 differs from Latin-1 in 0x80-0x9F (Node's TextDecoder treats it as Latin-1). */
const CP1252_HIGH = [
	0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d,
	0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
	0x017e, 0x0178,
];

function decodeWindows1252(data: Uint8Array): string {
	let text = "";
	for (let i = 0; i < data.length; i += 8192) {
		const codes = Array.from(data.subarray(i, i + 8192), (byte) =>
			byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte,
		);
		text += String.fromCharCode(...codes);
	}
	return text;
}

function utf8SequenceLength(data: Uint8Array, i: number): number {
	const b = data[i];
	const cont = (k: number, low = 0x80, high = 0xbf) =>
		i + k < data.length && data[i + k] >= low && data[i + k] <= high;
	if (b >= 0xc2 && b <= 0xdf) return cont(1) ? 2 : 0;
	if (b >= 0xe0 && b <= 0xef) {
		const [low, high] = b === 0xe0 ? [0xa0, 0xbf] : b === 0xed ? [0x80, 0x9f] : [0x80, 0xbf];
		return cont(1, low, high) && cont(2) ? 3 : 0;
	}
	if (b >= 0xf0 && b <= 0xf4) {
		const [low, high] = b === 0xf0 ? [0x90, 0xbf] : b === 0xf4 ? [0x80, 0x8f] : [0x80, 0xbf];
		return cont(1, low, high) && cont(2) && cont(3) ? 4 : 0;
	}
	return 0;
}

/** Decode UTF-8, reading each byte that is not part of a valid sequence as Windows-1252. */
function decodeUtf8WithFallback(data: Uint8Array): { text: string; fallbacks: number } {
	const utf8 = new TextDecoder("utf-8");
	const parts: string[] = [];
	let fallbacks = 0;
	let start = 0;
	let i = 0;
	while (i < data.length) {
		if (data[i] < 0x80) {
			i++;
			continue;
		}
		const length = utf8SequenceLength(data, i);
		if (length > 0) {
			i += length;
			continue;
		}
		parts.push(utf8.decode(data.subarray(start, i)), decodeWindows1252(data.subarray(i, i + 1)));
		fallbacks++;
		i++;
		start = i;
	}
	parts.push(utf8.decode(data.subarray(start)));
	return { text: parts.join(""), fallbacks };
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: string; warning?: string } {
	let data = bytes;
	if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) data = data.subarray(3);
	if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
		return { text: new TextDecoder("utf-16le").decode(data.subarray(2)), encoding: "utf-16le" };
	}
	if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
		return { text: new TextDecoder("utf-16be").decode(data.subarray(2)), encoding: "utf-16be" };
	}
	const utf16 = looksLikeUtf16(data);
	if (utf16) {
		return {
			text: new TextDecoder(utf16).decode(data),
			encoding: utf16,
			warning: `no byte order mark; decoded as ${utf16.toUpperCase()}`,
		};
	}
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "utf-8" };
	} catch {
		const lenient = new TextDecoder("utf-8").decode(data);
		// A UTF-8 file with a few damaged bytes still has mostly valid non-ASCII characters; a legacy 8-bit file has
		// none (its accented letters are exactly the invalid bytes).
		const validNonAscii = (lenient.match(/[^\x00-\x7F\uFFFD]/g) ?? []).length;
		const invalid = (lenient.match(/\uFFFD/g) ?? []).length;
		// Legacy 8-bit text can form a few valid UTF-8 sequences by accident ("là »"); real UTF-8 has far more
		// valid non-ASCII characters than damaged bytes.
		if (validNonAscii >= 4 * invalid) {
			// Mostly UTF-8 with stray legacy bytes (e.g. concatenated files): keep the UTF-8 and read only the invalid
			// bytes as Windows-1252.
			const mixed = decodeUtf8WithFallback(data);
			return {
				text: mixed.text,
				encoding: "utf-8",
				warning: `${mixed.fallbacks} byte(s) were not valid UTF-8 and were read as Windows-1252`,
			};
		}
		return {
			text: decodeWindows1252(data),
			encoding: "windows-1252",
			warning: "not valid UTF-8; decoded as Windows-1252",
		};
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
