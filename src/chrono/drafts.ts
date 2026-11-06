import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DocState, DraftRecord, UnitRecord } from "../agent/state.ts";
import { sha256Text } from "../agent/state.ts";
import type { Mode } from "../config.ts";
import type { LoadedSchema } from "../schemas/registry.ts";
import { canonicalPath } from "../util.ts";
import { adoptedExtraction, adoptedTranscription, labelNamesImage, parseAnswer } from "./document.ts";
import { inputIdentity } from "./identity.ts";
import { pyStrip } from "./py.ts";
import { readOnly } from "./sqlite.ts";
import { ChronoStore, DATABASE_NAMES, fileSha256, type StoreTool } from "./store.ts";

/**
 * Correction mode: the drafts of a document from a ChronoTranscriber or ChronoMiner store, read read-only through
 * the tools' views (`page_text`, `chunks`; the documents table for the recorded input hash).
 */

export interface DraftsStore {
	database: string;
	tool: StoreTool;
}

/** One stored unit that can seed a unit file. */
interface StoredDraft {
	text: string;
	runId: string;
	label: string | null;
}

export interface DocumentDrafts {
	database: string;
	tool: StoreTool;
	document: string;
	/** The input the store document was matched by (an image of a folder for ChronoMiner). */
	input: string;
	/** Stored units that can seed a unit, by 1-based unit index (CT order_index + 1, CM chunk_index). */
	units: Map<number, StoredDraft>;
	/** ChronoMiner text documents: the chunk ranges, which become Mabillon's units. */
	ranges?: Array<[number, number]>;
}

/** The mode's store at `path` (the database file or an output root holding it), checked for its schema versions. */
export function resolveDrafts(path: string, mode: Mode): DraftsStore {
	const tool: StoreTool = mode === "transcribe" ? "chronotranscriber" : "chronominer";
	const name = DATABASE_NAMES[tool];
	let database = resolve(path);
	if (!existsSync(database)) throw new Error(`--drafts ${path} does not exist`);
	if (statSync(database).isDirectory()) database = join(database, name);
	if (basename(database).toLowerCase() !== name || !existsSync(database)) {
		throw new Error(`--drafts ${path}: ${mode} takes its drafts from a ${name} (the file or an output root with it)`);
	}
	ChronoStore.inspect(dirname(database), tool);
	return { database, tool };
}

interface StoredDocument {
	name: string;
	kind: string | null;
	input_path: string | null;
	input_sha256: string | null;
}

/**
 * The drafts of each input (a PDF, image folder or text; for ChronoMiner image folders each image). The store
 * document is matched by its input path (case-insensitive on Windows and macOS); several matches need
 * `--drafts-document`. A recorded input hash must be the current one (none recorded: accepted with a warning).
 * Throws when no input has a store document.
 */
export function findDrafts(
	source: DraftsStore,
	inputs: string[],
	options: { select?: string; warn: (message: string) => void },
): DocumentDrafts[] {
	return readOnly(source.database, (c) => {
		const stored = c.all(
			"SELECT name, kind, input_path, input_sha256 FROM documents ORDER BY name",
		) as unknown as StoredDocument[];
		const found: DocumentDrafts[] = [];
		for (const input of inputs) {
			const key = canonicalPath(input);
			let matches = stored.filter((row) => row.input_path !== null && canonicalPath(row.input_path) === key);
			if (matches.length === 0) continue;
			// --drafts-document decides only between the documents of one input; unique matches stay as they are.
			if (matches.length > 1) {
				const names = matches.map((row) => row.name).join(", ");
				matches = matches.filter((row) => row.name === options.select);
				if (matches.length !== 1) {
					throw new Error(
						`several documents of ${source.database} have the input ${input}: ${names}; ${options.select === undefined ? "choose one with --drafts-document" : `--drafts-document ${options.select} is none of them`}`,
					);
				}
			}
			const row = matches[0];
			const current = source.tool === "chronotranscriber" ? inputIdentity(input) : fileSha256(input);
			if (row.input_sha256 === null) {
				options.warn(`the drafts document '${row.name}' records no input hash; its input is taken as ${input}`);
			} else if (row.input_sha256 !== current) {
				throw new Error(
					`the drafts document '${row.name}' in ${source.database} was made from another version of ${input} (stored ${row.input_sha256.slice(0, 12)}..., now ${(current ?? "none").slice(0, 12)}...)`,
				);
			}
			found.push({ ...readUnits(c, source, row), input });
		}
		if (found.length === 0) {
			throw new Error(
				`no document of ${source.database} has the input ${inputs.length === 1 ? inputs[0] : `${dirname(inputs[0])} (or one of its images)`}`,
			);
		}
		return found;
	});
}

function readUnits(
	c: Parameters<Parameters<typeof readOnly>[1]>[0],
	source: DraftsStore,
	row: StoredDocument,
): Omit<DocumentDrafts, "input"> {
	const units = new Map<number, StoredDraft>();
	const base = { database: source.database, tool: source.tool, document: row.name, units };
	if (source.tool === "chronotranscriber") {
		const native = c.get("SELECT count(*) AS n FROM page_text WHERE document = ? AND kind != 'page'", row.name);
		if (Number(native?.n ?? 0) > 0) {
			throw new Error(
				`the drafts document '${row.name}' in ${source.database} holds ChronoTranscriber's native PDF text (units of kind text), not page transcriptions; it cannot seed pages`,
			);
		}
		// page_text has no stale flag; it comes from the unit row.
		for (const page of c.all(
			"SELECT p.order_index, p.image_name, p.text, p.status, p.outcome, p.run_id, u.stale FROM page_text AS p JOIN documents AS d ON d.name = p.document JOIN units AS u ON u.doc_id = d.doc_id AND u.kind = p.kind AND u.idx = p.order_index WHERE p.document = ? AND p.kind = 'page'",
			row.name,
		)) {
			if (page.status !== "done" || page.outcome !== "ok" || Number(page.stale) === 1) continue;
			if (typeof page.text !== "string") continue;
			units.set(Number(page.order_index) + 1, {
				text: page.text,
				runId: String(page.run_id),
				label: page.image_name === null ? null : String(page.image_name),
			});
		}
		return base;
	}
	const chunks = c.all(
		"SELECT chunk_index, source_index, status, output_text, stale, run_id FROM chunks WHERE document = ? ORDER BY chunk_index",
		row.name,
	);
	for (const chunk of chunks) {
		if (chunk.status !== "done" || Number(chunk.stale) === 1 || typeof chunk.output_text !== "string") continue;
		units.set(Number(chunk.chunk_index), { text: chunk.output_text, runId: String(chunk.run_id), label: null });
	}
	if (row.kind !== "text") return base;
	const ranges = chunks.map((chunk) => {
		const match = /^(\d+)-(\d+)$/.exec(String(chunk.source_index ?? ""));
		if (!match)
			throw new Error(`the drafts document '${row.name}' has a chunk without a line range (${chunk.source_index})`);
		return [Number(match[1]), Number(match[2])] as [number, number];
	});
	return { ...base, ranges };
}

/** ChronoMiner's chunk ranges in the form of a `_line_ranges.txt` file. */
export function rangesText(ranges: Array<[number, number]>): string {
	return ranges.map(([start, end]) => `(${start}, ${end})`).join("\n");
}

/**
 * The draft of a unit and its document, if one fits: a ChronoMiner image document holds one page (its chunk 1);
 * a ChronoTranscriber image folder page must name the unit's image.
 */
function draftFor(
	drafts: DocumentDrafts[],
	tool: StoreTool,
	unit: UnitRecord,
): { document: DocumentDrafts; draft: StoredDraft } | "unmatched" | undefined {
	if (tool === "chronominer" && unit.image) {
		const document = drafts.find((d) => canonicalPath(d.input) === canonicalPath(unit.image as string));
		const draft = document?.units.get(1);
		return document && draft ? { document, draft } : undefined;
	}
	const document = drafts[0];
	const draft = document.units.get(unit.index);
	if (!draft) return undefined;
	// A folder page without a stored image name, or with another one, cannot be matched to the unit's image.
	if (
		tool === "chronotranscriber" &&
		unit.image &&
		(draft.label === null || !labelNamesImage(draft.label, unit.image))
	) {
		return "unmatched";
	}
	return { document, draft };
}

/**
 * The unit files a fresh run is seeded with: a page's stored text below the schema's empty front matter, or a
 * chunk's stored answer as indented JSON; each seeded unit records its draft. Units without a usable draft are
 * worked from scratch (warned for drafts that cannot be read). The files are written by the caller, once the
 * output store has accepted the document.
 */
export function seedDrafts(
	drafts: DocumentDrafts[],
	state: DocState,
	schema: LoadedSchema,
	warn: (message: string) => void,
): Array<{ unit: UnitRecord; content: string }> {
	const tool = drafts[0].tool;
	const seeded: Array<{ unit: UnitRecord; content: string }> = [];
	for (const unit of state.units) {
		const found = draftFor(drafts, tool, unit);
		if (!found) continue;
		if (found === "unmatched") {
			// Its stored page cannot be matched to the unit's image: neither a draft nor a row to adopt.
			warn(
				`${unit.id}: the stored page does not name ${basename(unit.image ?? "")}; the page is transcribed from scratch`,
			);
			unit.draftRejected = true;
			continue;
		}
		const { document, draft } = found;
		let content: string;
		if (state.mode === "transcribe") {
			if (pyStrip(draft.text) === "") {
				warn(`${unit.id}: the draft is empty; the page is transcribed from scratch`);
				unit.draftRejected = true;
				continue;
			}
			content = adoptedTranscription(draft.text, schema);
		} else {
			if (!parseAnswer(draft.text)) {
				warn(`${unit.id}: the draft is no JSON object; the unit is extracted from scratch`);
				unit.draftRejected = true;
				continue;
			}
			content = adoptedExtraction(draft.text);
		}
		const record: DraftRecord = {
			store: document.database,
			document: document.document,
			tool,
			runId: draft.runId,
			sha256: sha256Text(content),
		};
		unit.draft = record;
		seeded.push({ unit, content });
	}
	return seeded;
}
