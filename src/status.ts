import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readCommitted } from "./agent/runtime.ts";
import { activeLock, type DocState, docPaths, isDone, loadState, type UnitRecord, unitsDigest } from "./agent/state.ts";

export interface DocumentStatus {
	stem: string;
	source: string;
	mode: DocState["mode"];
	schema: string;
	outputDir: string;
	units: number;
	committed: number;
	needsReview: Array<{ unit: string; reason?: string }>;
	/** Unfinished units, including damaged ones. */
	pending: number;
	/** Finished units whose committed copy is missing or was changed; counted as pending. */
	damaged: Array<{ unit: string; error: string }>;
	/** Every unit finished and intact, and the last export succeeded with a valid merged output. */
	complete: boolean;
	/** Why a document whose units are all finished is still not complete. */
	incompleteReason?: string;
	/** Schema errors of the merged output at the last export. */
	finalValidation?: string[];
	/** Why the last export failed. */
	exportError?: string;
	/** Another Mabillon process holds the document's lock. */
	running: boolean;
	sessions: number;
	cost: number;
	updatedAt: string;
	warnings?: string[];
	lastError?: string;
}

function statusOf(docDir: string, state: DocState): DocumentStatus {
	const lastSession = state.sessions[state.sessions.length - 1];
	// A finished unit whose canonical copy is missing or was changed counts as damaged and pending (the export marks
	// it as an integrity error, and the next run reopens it).
	const runtime = { paths: docPaths(docDir), mode: state.mode };
	const damaged: Array<{ unit: string; error: string }> = [];
	for (const unit of state.units) {
		const { problem } = readCommitted(runtime, unit);
		if (problem) damaged.push({ unit: unit.id, error: problem });
	}
	const damagedIds = new Set(damaged.map((item) => item.unit));
	const intact = (unit: UnitRecord) => !damagedIds.has(unit.id);
	const pending = state.units.filter((unit) => !isDone(unit) || !intact(unit)).length;
	// The outputs count only if the last export was made from the current unit state and its files still exist.
	const exported = state.export;
	const exportCurrent =
		exported?.unitsDigest === unitsDigest(state.units) &&
		(exported.files ?? []).length > 0 &&
		(exported.files ?? []).every((file) => existsSync(join(docDir, file)));
	return {
		stem: state.stem,
		source: state.source,
		mode: state.mode,
		schema: state.schema.name,
		outputDir: docDir,
		units: state.units.length,
		committed: state.units.filter((unit) => unit.status === "committed" && intact(unit)).length,
		needsReview: state.units
			.filter((unit) => unit.status === "needs_review" && intact(unit))
			.map((unit) => ({ unit: unit.id, reason: unit.closedReason })),
		pending,
		damaged,
		complete: pending === 0 && exportCurrent && !state.export?.finalValidation?.length && !state.export?.error,
		...(pending === 0 && !exportCurrent ? { incompleteReason: "export missing or stale" } : {}),
		finalValidation: state.export?.finalValidation,
		exportError: state.export?.error,
		running: activeLock(join(docDir, "run")) !== undefined,
		sessions: state.sessions.length,
		cost: Number(state.sessions.reduce((sum, session) => sum + (session.cost ?? 0), 0).toFixed(6)),
		updatedAt: state.updatedAt,
		warnings: state.warnings,
		lastError: lastSession?.error,
	};
}

function docState(docDir: string): DocState | undefined {
	return existsSync(join(docDir, "run", "state.json")) ? loadState(join(docDir, "run")) : undefined;
}

const MAX_DEPTH = 8;

/** The document working folders below `dir` (folders with run/state.json), in name order. */
function workingFolders(dir: string, depth: number): string[] {
	if (depth > MAX_DEPTH) return [];
	const found: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return found;
	}
	for (const name of names) {
		const child = join(dir, name);
		try {
			if (!statSync(child).isDirectory()) continue;
		} catch {
			continue;
		}
		if (existsSync(join(child, "run", "state.json"))) found.push(child);
		else if (name !== "run" && name !== "work") found.push(...workingFolders(child, depth + 1));
	}
	return found;
}

/**
 * Read run state without a model: `path` may be a document's working folder (`.mabillon/<name>/`, which holds
 * run/), its run/ or work/ folder, or an output root, whose `.mabillon/` folder holds one working folder per
 * document.
 */
export function collectStatus(path: string): DocumentStatus[] {
	const root = resolve(path);
	if (!existsSync(root)) throw new Error(`Not found: ${root}`);
	const docDir = basename(root) === "run" || basename(root) === "work" ? dirname(root) : root;
	const direct = docState(docDir);
	if (direct) return [statusOf(docDir, direct)];
	const base = existsSync(join(root, ".mabillon")) ? join(root, ".mabillon") : root;
	const results: DocumentStatus[] = [];
	for (const dir of workingFolders(base, 0)) {
		const state = docState(dir);
		if (state) results.push(statusOf(dir, state));
	}
	return results;
}
