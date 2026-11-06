import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Mode } from "../config.ts";
import { canonicalPath, ensureDir, readJson, writeJson } from "../util.ts";
import type { Issue } from "../verify/issues.ts";

export type UnitStatus = "pending" | "committed" | "needs_review";
export type InputKind = "images" | "text";

export interface UnitRecord {
	/** p0001 (page) or c0001 (text chunk). */
	id: string;
	/** 1-based position in the document. */
	index: number;
	status: UnitStatus;
	/** Image units from image files: the file. */
	image?: string;
	/** Image units from multi-page TIFFs: 0-based page within the file. */
	imagePage?: number;
	/** Image units from PDFs: 1-based page number in the PDF. */
	pdfPage?: number;
	/** Text units: 1-based line range within the converted document text. */
	startLine?: number;
	endLine?: number;
	/** Note from the agent about text at the start of the next unit(s) that belongs to an entry recorded here. */
	carryOver?: string;
	/** Issues remaining when the unit was committed or closed. */
	issues?: Issue[];
	/** Why a unit was closed without a passing verify (tool budget, agent stopped, unreadable page). */
	closedReason?: string;
	/** sha256 of the committed unit file. */
	contentHash?: string;
	/**
	 * A unit another tool finished in the shared ChronoTranscriber or ChronoMiner store: its stored content is the
	 * committed copy, the agent does not work it, and its store row stays as that tool wrote it.
	 */
	adopted?: { tool: string; runId: string; model?: string; outcome?: string };
	/**
	 * The unit's store row as Mabillon last saw it (at the start of a run, before any agent work) or wrote it (at the
	 * export). A row with another run_id, status or stale flag was reset or replaced since (ChronoTranscriber and
	 * ChronoMiner keep the tool column when they do), and a finished unit is then worked again.
	 */
	storeRow?: { status: string; stale: number; runId: string };
	/**
	 * Extraction: entries add_entries rejected that no later call resolved (kept across sessions until the unit is
	 * committed or reset), and the number of the next rejection ID.
	 */
	rejections?: { next: number; pending: Array<{ id: string; text: string; position?: number }> };
	/** 1-based number of the session that committed or closed the unit (its model, thinking and tools). */
	session?: number;
	/** Inspection calls refused because the soft cap was reached. */
	softCapBlocks?: number;
	/** The unit was closed for review because its tool budget (hard cap) ran out: a censored unit. */
	hardCapClosed?: boolean;
	toolCalls?: number;
	views?: number;
	verifyRuns?: number;
	committedAt?: string;
}

export interface SessionRecord {
	file?: string;
	startedAt: string;
	endedAt?: string;
	units: string[];
	model?: string;
	thinking?: string;
	/** The agent's tools in this session. */
	tools?: string[];
	/** The image profile used in this session (label of the resolved profile). */
	imageProfile?: string;
	/** OpenRouter provider preferences sent with the session's requests. */
	routing?: Record<string, unknown>;
	/** OpenAI service tier requested for the session's requests (service_tier). */
	serviceTier?: string;
	/** Upstream providers that served the session's requests, as OpenRouter reports them. */
	servedBy?: string[];
	compactions?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cost?: number;
	error?: string;
}

/** What the units were built from; a resume must see the same source. */
export interface SourceFingerprint {
	/** sha256 of the PDF/text file, or of the image folder listing (names, sizes, modification times). */
	source: string;
	/** Text documents: chunk size, line-range file hash, and hash of the converted text. */
	chunkTokens?: number;
	lineRanges?: string;
	text?: string;
}

/**
 * What an experiment arm consists of, apart from the model: the tool set, the resolved settings that change the
 * agent's behavior, the context files, the boundary policy and the system prompt. Recorded at the start; a resume
 * with different values is refused.
 */
export interface ExperimentRecord {
	tools: string[];
	boundary?: string;
	settings: Record<string, unknown>;
	context: { texts: Array<{ file: string; sha256: string }>; images: Array<{ file: string; sha256: string }> };
	systemPromptSha256: string;
}

/** Digest of the units' finished state, to tell whether an export is current. */
export function unitsDigest(units: UnitRecord[]): string {
	return sha256Text(JSON.stringify(units.map((unit) => [unit.id, unit.status, unit.contentHash ?? null])));
}

export interface DocState {
	version: 2;
	mabillonVersion: string;
	mode: Mode;
	inputKind: InputKind;
	source: string;
	stem: string;
	fingerprint: SourceFingerprint;
	schema: { name: string; sha256: string; path: string };
	units: UnitRecord[];
	totalLines?: number;
	/** Problems noticed while preparing the document (encoding, line ranges); reported with every result. */
	warnings?: string[];
	sessions: SessionRecord[];
	/** The agent's tools in the latest session (each session also records its own). */
	tools?: string[];
	/** Settings that shape the agent's behavior; a resume must use the same (see ExperimentRecord). */
	experiment?: ExperimentRecord;
	/** Image fidelity downgrades after the provider rejected an image request. */
	imageFallbacks?: Array<{ session: number; model?: string; from: string; to: string }>;
	/** Line-range gaps accepted with allow_partial_ranges: these source lines are in no unit. */
	uncoveredLines?: string[];
	/**
	 * Outcome of the last export (read by `status`): schema errors of the merged output, or why it failed, the unit
	 * state it was made from (`unitsDigest`), the files written (relative to the document's working folder) and, for a
	 * transcription without a store row, the hashes of its text files (the overwrite guard's record).
	 */
	export?: {
		at: string;
		finalValidation?: string[];
		error?: string;
		unitsDigest?: string;
		files?: string[];
		hashes?: Record<string, string>;
	};
	createdAt: string;
	updatedAt: string;
}

/**
 * Working folder of one document, `<output root>/.mabillon/<document name>/` (the outputs sit in the output root):
 *   <docDir>/work/                               the agent's working directory (units/, notes.md, scratch/, source/)
 *   <docDir>/run/                                internal: state.json, lock, text/, committed/, sessions/
 */
export interface DocPaths {
	docDir: string;
	workDir: string;
	runDir: string;
	textDir: string;
	committedDir: string;
	sessionsDir: string;
}

export function docPaths(docDir: string): DocPaths {
	const runDir = join(docDir, "run");
	return {
		docDir,
		workDir: join(docDir, "work"),
		runDir,
		textDir: join(runDir, "text"),
		committedDir: join(runDir, "committed"),
		sessionsDir: join(runDir, "sessions"),
	};
}

export function statePath(runDir: string): string {
	return join(runDir, "state.json");
}

export function loadState(runDir: string): DocState | undefined {
	const path = statePath(runDir);
	if (!existsSync(path)) return undefined;
	const state = readJson<DocState>(path);
	if (state.version !== 2) {
		throw new Error(`${path} was written by an incompatible Mabillon version; rerun with --force`);
	}
	return state;
}

export function saveState(runDir: string, state: DocState): void {
	state.updatedAt = new Date().toISOString();
	writeJson(statePath(runDir), state);
}

/** Unit output file name (relative to work/ and to run/committed/). */
export function unitFileName(mode: Mode, unit: UnitRecord): string {
	return mode === "transcribe" ? `${unit.id}.md` : `${unit.id}.json`;
}

/** Unit output file, relative to the work directory. */
export function unitFile(mode: Mode, unit: UnitRecord): string {
	return `units/${unitFileName(mode, unit)}`;
}

/** Text chunk file, relative to the work directory (materialized only when within the agent's reach). */
export function chunkFile(unit: UnitRecord): string {
	return `source/${unit.id}.txt`;
}

export function isDone(unit: UnitRecord): boolean {
	return unit.status === "committed" || unit.status === "needs_review";
}

export function sha256File(path: string): string {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(1 << 20);
		for (let read = readSync(fd, buffer, 0, buffer.length, null); read > 0; ) {
			hash.update(buffer.subarray(0, read));
			read = readSync(fd, buffer, 0, buffer.length, null);
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Fingerprint of an image folder: names, sizes and modification times of its page files. */
export function imageListFingerprint(images: string[]): string {
	return sha256Text(
		JSON.stringify(
			images.map((path) => {
				const stats = statSync(path);
				return [path.split(/[\\/]/).pop(), stats.size, Math.round(stats.mtimeMs)];
			}),
		),
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Run lock: one process per document output folder.

interface LockInfo {
	pid: number;
	host: string;
	startedAt: string;
	/** Identifies the acquisition, so that a release never removes a lock someone else took over. */
	token?: string;
}

/** A lock file that cannot be parsed is taken as held while it is this young (its writer may still be writing). */
const UNREADABLE_LOCK_GRACE_MS = 30_000;

/** Lock files held by this process (two workers of one run must not share a document). */
const heldLocks = new Set<string>();

function lockPath(runDir: string): string {
	return join(runDir, "lock");
}

function readRaw(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function parseLock(raw: string | undefined): LockInfo | undefined {
	if (raw === undefined) return undefined;
	try {
		const info = JSON.parse(raw) as LockInfo;
		return typeof info?.pid === "number" && typeof info.host === "string" ? info : undefined;
	} catch {
		return undefined;
	}
}

function readLock(path: string): LockInfo | undefined {
	return parseLock(readRaw(path));
}

/** Create a file only if it does not exist; false if it does. */
function createExclusive(path: string, content: string): boolean {
	try {
		writeFileSync(path, content, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/** Whether a guard may be cleared: its owner is a dead process on this host, or it is unreadable and old. */
function guardAbandoned(guard: string, raw: string | undefined): boolean {
	const owner = parseLock(raw);
	if (owner) return owner.host === hostname() && !processAlive(owner.pid);
	try {
		return Date.now() - statSync(guard).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
	} catch {
		return false;
	}
}

/** How often and how long to wait for a guard held by another live process (it is held for milliseconds). */
const GUARD_ATTEMPTS = 20;
const GUARD_WAIT_MS = 50;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockRefusal(path: string, holder: LockInfo | undefined): Error {
	const who = holder
		? `pid ${holder.pid} on ${holder.host}, started ${holder.startedAt}`
		: "lock file being written or unreadable";
	return new Error(
		`another Mabillon run (${who}) is working on this document; wait for it, or delete ${path} if it is gone`,
	);
}

/**
 * Take the guard file `lock.recover`, which every acquisition holds while it checks and creates the lock. A guard
 * whose owner on this host is dead (or that is unreadable and old) is removed. Remaining window: two processes
 * removing the same dead guard at the same moment; since a guard is held only for milliseconds, this needs a crash
 * inside that window. Returns the guard's content (ours), to check before releasing it.
 */
function takeGuard(guard: string): string {
	const owner = JSON.stringify({
		pid: process.pid,
		host: hostname(),
		startedAt: new Date().toISOString(),
		token: randomUUID(),
	});
	for (let attempt = 0; attempt < GUARD_ATTEMPTS; attempt++) {
		if (createExclusive(guard, owner)) return owner;
		if (guardAbandoned(guard, readRaw(guard))) {
			try {
				rmSync(guard, { force: true });
			} catch (error) {
				throw new Error(`could not remove the abandoned lock guard ${guard}: ${(error as Error).message}`);
			}
			continue;
		}
		sleepSync(GUARD_WAIT_MS);
	}
	throw new Error(
		`another Mabillon process is checking this document's lock (${guard}); try again, or delete the file if no run is active`,
	);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The live lock holder, if another process on this machine is working on the document. */
export function activeLock(runDir: string): LockInfo | undefined {
	const info = readLock(lockPath(runDir));
	if (!info) return undefined;
	if (info.host !== hostname()) return info;
	return info.pid !== process.pid && processAlive(info.pid) ? info : undefined;
}

/**
 * Take the document's lock. Every acquisition holds the guard file `lock.recover` while it reads and creates the
 * lock, so checking and replacing a stale lock cannot interleave with another acquisition. An existing lock is
 * removed only when its holder is a dead process on this machine (or the file is unreadable and old); locks of
 * other hosts are never broken. Unexpected file-system errors refuse the lock and delete nothing else.
 * `insideGuard` lets tests pause while the guard is held.
 */
export function acquireLock(runDir: string, options: { insideGuard?: () => void } = {}): () => void {
	ensureDir(runDir);
	const path = lockPath(runDir);
	// One key per folder however it is spelled (case, drive letter case, symlinks).
	const key = join(canonicalPath(runDir), "lock");
	if (heldLocks.has(key)) {
		throw new Error("another worker of this run is already working on this document");
	}
	const info: LockInfo = {
		pid: process.pid,
		host: hostname(),
		startedAt: new Date().toISOString(),
		token: randomUUID(),
	};
	const guard = `${path}.recover`;
	const owner = takeGuard(guard);
	try {
		options.insideGuard?.();
		if (existsSync(path)) {
			const holder = readLock(path);
			let stale: boolean;
			if (!holder) {
				let age = 0;
				try {
					age = Date.now() - statSync(path).mtimeMs;
				} catch {
					// cannot tell: held
				}
				stale = age > UNREADABLE_LOCK_GRACE_MS;
			} else {
				// Our own pid without an entry in heldLocks: left by an earlier process that had the same pid.
				stale = holder.host === hostname() && (holder.pid === process.pid || !processAlive(holder.pid));
			}
			if (!stale) throw lockRefusal(path, holder);
			try {
				rmSync(path);
			} catch (error) {
				throw new Error(`could not remove the stale lock ${path}: ${(error as Error).message}`);
			}
		}
		if (!createExclusive(path, JSON.stringify(info))) throw lockRefusal(path, readLock(path));
	} finally {
		// Release the guard only if it is still ours.
		if (readRaw(guard) === owner) {
			try {
				rmSync(guard);
			} catch {
				// left in place; a later acquisition removes it once this process has ended
			}
		}
	}
	heldLocks.add(key);
	return () => {
		heldLocks.delete(key);
		if (readLock(path)?.token === info.token) rmSync(path, { force: true });
	};
}
