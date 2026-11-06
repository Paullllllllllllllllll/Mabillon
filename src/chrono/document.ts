import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { committedPath } from "../agent/runtime.ts";
import { type DocPaths, type DocState, sha256Text, type UnitRecord, unitFile } from "../agent/state.ts";
import type { Mode } from "../config.ts";
import type { SourceDocument } from "../inputs/discover.ts";
import type { LoadedSchema } from "../schemas/registry.ts";
import { writeFileAtomic } from "../util.ts";
import { parseTranscriptionUnit } from "../verify/rules.ts";
import { inputIdentity } from "./identity.ts";
import {
	CM_OUTPUT_SUFFIX,
	cmCsvPath,
	cmLocation,
	ctFormatPath,
	ctLocation,
	type ExtractionLayout,
	listFolderImages,
	realPath,
	type TranscriptionLayout,
} from "./paths.ts";
import { PyNumberLexeme, pyJsonDumps, pyJsonParse, pyStem, pyStrip } from "./py.ts";
import { documentMetadata, renderCsv, renderOutputJson, writeEntries, writeMetadata } from "./render-cm.ts";
import {
	detectCause,
	NO_TEXT_PLACEHOLDER,
	NOT_POSSIBLE_PLACEHOLDER,
	type RenderUnit,
	renderDocument,
	renderedUnitCount,
	renderUnits,
	type TextFormat,
} from "./render-ct.ts";
import type { Connection } from "./sqlite.ts";
import {
	ChronoStore,
	cmReplaceChunks,
	cmResetChunks,
	ctForcedReplacement,
	DATABASE_NAMES,
	type DocumentRow,
	emptyReport,
	fileSha256,
	isoTime,
	type Lease,
	type PlannedUnit,
	planUnits,
	type RenderReport,
	type RenderTarget,
	type RunInfo,
	recordedOutputs,
	recordIdentity,
	recordOutput,
	refreshDocument,
	refuseBlocking,
	type StoreTool,
	textSha256,
	type UnitRow,
	type UnitWrite,
	unitSignature,
	writeGuarded,
	writeUnit,
} from "./store.ts";

/**
 * A Mabillon document as ChronoTranscriber (transcription) or ChronoMiner (extraction) documents: where its files
 * go, which store documents it fills, and how its units become their rows. Transcription writes one CT document
 * per PDF or image folder; extraction one CM document per text or PDF and one per image of an image folder.
 */

const PLAIN_TEXT = new Set([".txt", ".md", ".markdown"]);

export const MABILLON_DIR = ".mabillon";
export const SIDECAR_SUFFIX = ".mabillon.json";
/** Suffix of an extraction's working folder and sidecar names (ChronoMiner's `<stem>_output`). */
const EXTRACTION_SUFFIX = "_output";

/**
 * The converted text of a text document in its run folder, `text/<stem>.txt` (the chunk texts `text/c0001.txt`
 * beside it; a stem of that form goes to `text/source/`).
 */
export function documentTextPath(runDir: string, inputName: string): string {
	const stem = pyStem(inputName);
	return /^c\d+$/i.test(stem) ? join(runDir, "text", "source", `${stem}.txt`) : join(runDir, "text", `${stem}.txt`);
}

export interface OutputOptions {
	/** Output root given with --out (real path); undefined writes beside the input. */
	outDir?: string;
	layout: string;
	formats: string[];
}

export interface StoreDocPlan {
	name: string;
	inputPath: string;
	kind: string;
	unitKind: "page" | "chunk";
	/** Rendered files: CT txt/md, CM json and csv. */
	outputs: Array<{ format: string; path: string }>;
	/** The image of a ChronoMiner image document. */
	image?: string;
}

export interface ChronoPlan {
	tool: StoreTool;
	root: string;
	/** The document's name below `<root>/.mabillon/`. */
	name: string;
	workingDir: string;
	/** Folder of the rendered files and the sidecar. */
	outputDir: string;
	sidecar: string;
	/** Candidate store documents (CM image folders: one per readable image). */
	documents: StoreDocPlan[];
	/** Text formats of a transcription without a store row (rendered from the units alone). */
	textOutputs?: Array<{ format: string; path: string }>;
}

/** The text formats a transcription renders (`text_formats`): txt and md in the given order, txt when none. */
export function textFormats(formats: string[]): TextFormat[] {
	const chosen = formats.filter((format): format is TextFormat => format === "txt" || format === "md");
	return chosen.length > 0 ? [...new Set(chosen)] : ["txt"];
}

/** The chunk formats an extraction renders (`output_formats`): json, and csv when asked for. */
export function chunkFormats(formats: string[]): string[] {
	return formats.includes("csv") ? ["json", "csv"] : ["json"];
}

function isStrictUtf8(path: string): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
		return true;
	} catch {
		return false;
	}
}

/** Where a document writes and which store documents it fills (no file is touched). */
export function planDocument(doc: SourceDocument, mode: Mode, options: OutputOptions): ChronoPlan {
	const item = realPath(doc.path);
	const inputRoot = realPath(doc.inputRoot ?? doc.path);
	const isFolder = doc.kind === "images" && statSync(item).isDirectory();
	if (mode === "transcribe") {
		const formats = textFormats(options.formats);
		const location = ctLocation(item, isFolder, {
			outputDir: options.outDir,
			layout: options.layout as TranscriptionLayout,
			inputRoot,
			firstFormat: formats[0],
		});
		const base = location.output.slice(0, location.output.length - extname(location.output).length);
		const outputs = formats.map((format) => ({ format, path: ctFormatPath(location.output, format) }));
		const storable = doc.kind === "pdf" || isFolder;
		return {
			tool: "chronotranscriber",
			root: location.root,
			name: location.name,
			workingDir: join(location.root, MABILLON_DIR, ...location.name.split("/")),
			outputDir: dirname(location.output),
			sidecar: `${base}${SIDECAR_SUFFIX}`,
			documents: storable
				? [
						{
							name: location.name,
							inputPath: item,
							kind: doc.kind === "pdf" ? "pdf" : "images",
							unitKind: "page",
							outputs,
						},
					]
				: [],
			textOutputs: storable ? undefined : outputs,
		};
	}
	const layout = options.layout as ExtractionLayout;
	const formats = chunkFormats(options.formats);
	const cmOutputs = (output: string) =>
		formats.map((format) => ({ format, path: format === "csv" ? cmCsvPath(output) : output }));
	if (isFolder) {
		const images = listFolderImages(item);
		const probe = cmLocation(join(item, "probe.png"), { outputDir: options.outDir, layout, inputRoot });
		const outputDir = dirname(probe.output);
		// The folder's name below the output root: the mirrored folders of its images' documents (`A/scan`), or the
		// folder name when they are written directly into the root. The working state and the sidecar take the
		// `_output` name, so an extraction never shares them with the transcription of the same input.
		const mirrored = dirname(probe.name);
		const name = `${mirrored === "." ? basename(item) : mirrored}${EXTRACTION_SUFFIX}`;
		return {
			tool: "chronominer",
			root: probe.root,
			name,
			workingDir: join(probe.root, MABILLON_DIR, ...name.split("/")),
			outputDir,
			sidecar: join(outputDir, `${basename(item)}${EXTRACTION_SUFFIX}${SIDECAR_SUFFIX}`),
			documents: images.map((image) => {
				const location = cmLocation(image, { outputDir: options.outDir, layout, inputRoot });
				return {
					name: location.name,
					inputPath: image,
					kind: "image",
					unitKind: "chunk" as const,
					outputs: cmOutputs(location.output),
					image,
				};
			}),
		};
	}
	const location = cmLocation(item, { outputDir: options.outDir, layout, inputRoot });
	const base = location.output.slice(0, location.output.length - CM_OUTPUT_SUFFIX.length);
	const name = `${location.name}${EXTRACTION_SUFFIX}`;
	const workingDir = join(location.root, MABILLON_DIR, ...name.split("/"));
	const converted = doc.kind === "text" && (!PLAIN_TEXT.has(extname(item).toLowerCase()) || !isStrictUtf8(item));
	const kind = doc.kind === "text" ? "text" : doc.kind === "pdf" ? "pdf" : "image";
	return {
		tool: "chronominer",
		root: location.root,
		name,
		workingDir,
		outputDir: dirname(location.output),
		sidecar: `${base}${EXTRACTION_SUFFIX}${SIDECAR_SUFFIX}`,
		documents: [
			{
				name: location.name,
				// ChronoMiner names a document by its input's stem, so the converted text keeps the input's stem.
				inputPath: converted ? documentTextPath(join(workingDir, "run"), basename(item)) : item,
				kind,
				unitKind: "chunk",
				outputs: cmOutputs(location.output),
				...(kind === "image" ? { image: item } : {}),
			},
		],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Units

interface MappedUnit {
	unit: UnitRecord;
	planned: PlannedUnit;
}

function pad4(value: number): string {
	return String(value).padStart(4, "0");
}

/** The units of each store document, keyed by store document name; documents that cannot hold them are dropped. */
function mapUnits(plan: ChronoPlan, state: DocState, warn: (message: string) => void): Map<string, MappedUnit[]> {
	const mapped = new Map<string, MappedUnit[]>();
	if (plan.tool === "chronotranscriber") {
		const document = plan.documents[0];
		if (!document) return mapped;
		if (document.kind === "pdf") {
			mapped.set(
				document.name,
				state.units.map((unit) => {
					const label = `page_${pad4(unit.index)}_pre_processed.jpg`;
					return { unit, planned: { idx: unit.index - 1, label, sourceIndex: unit.index - 1 } };
				}),
			);
			return mapped;
		}
		const listing = listFolderImages(document.inputPath);
		const pages = state.units.map((unit) => unit.image ?? "");
		const same =
			listing.length === pages.length &&
			state.units.every((unit) => unit.imagePage === undefined || unit.imagePage === 0) &&
			listing.every((image, i) => basename(image) === basename(pages[i]));
		if (!same) {
			warn(
				"its pages do not match ChronoTranscriber's page list of the folder (a multi-page TIFF); the text files and the sidecar are written, the store gets no row",
			);
			plan.textOutputs = document.outputs;
			return mapped;
		}
		mapped.set(
			document.name,
			state.units.map((unit) => {
				const label = `${basename(unit.image as string)}_pre_processed.jpg`;
				return { unit, planned: { idx: unit.index - 1, label, sourceIndex: label } };
			}),
		);
		return mapped;
	}
	for (const document of plan.documents) {
		if (document.kind === "text") {
			mapped.set(
				document.name,
				state.units.map((unit) => {
					const range = `${unit.startLine}-${unit.endLine}`;
					return { unit, planned: { idx: unit.index - 1, label: range, sourceIndex: range } };
				}),
			);
		} else if (document.kind === "pdf") {
			mapped.set(
				document.name,
				state.units.map((unit) => ({
					unit,
					planned: { idx: unit.index - 1, label: `page_${pad4(unit.index)}`, sourceIndex: unit.index - 1 },
				})),
			);
		} else {
			const units = state.units.filter((unit) => unit.image && realPath(unit.image) === document.image);
			if (units.length > 1) {
				// ChronoMiner has no document of several pages of one image file, so its outputs cannot be written.
				throw new Error(
					`${basename(document.inputPath)} has ${units.length} pages (a multi-page TIFF), which ChronoMiner reads as one image; split it into one image per page`,
				);
			}
			if (units.length === 0) continue;
			const name = basename(document.inputPath);
			mapped.set(document.name, [{ unit: units[0], planned: { idx: 0, label: name, sourceIndex: name } }]);
		}
	}
	return mapped;
}

/** Python's `str.strip()` of a unit's transcription, or the placeholder of its flags. */
function transcriptionContent(content: string, schema: LoadedSchema): { outcome: string; content: string } {
	const parsed = parseTranscriptionUnit(content, schema);
	const data = parsed.data;
	if (data?.no_transcribable_text === true) return { outcome: "no_text", content: NO_TEXT_PLACEHOLDER };
	if (data?.transcription_not_possible === true) return { outcome: "not_possible", content: NOT_POSSIBLE_PLACEHOLDER };
	const bodyField = schema.rules.bodyField ?? "transcription";
	const body = data && typeof data[bodyField] === "string" ? (data[bodyField] as string) : (parsed.body ?? "");
	return { outcome: "ok", content: pyStrip(body) };
}

function readCanonical(paths: DocPaths, mode: Mode, unit: UnitRecord): string | undefined {
	const path = committedPath({ paths, mode }, unit);
	if (!existsSync(path)) return undefined;
	const content = readFileSync(path, "utf8");
	return unit.contentHash && sha256Text(content) !== unit.contentHash ? undefined : content;
}

/** A JSON object in a model answer (as ChronoMiner's `parse_json_object` finds it, without the salvage step). */
export function parseAnswer(text: string): Record<string, unknown> | undefined {
	const candidates = [text.trim()];
	const fence = /^```[^\n]*\n([\s\S]*?)\n\s*```\s*$/.exec(text.trim());
	if (fence) candidates.push(fence[1]);
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first >= 0 && first < last) candidates.push(text.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			// Python's json reads `1.0` as a float; the entries keep that for the entry rows and the CSV.
			const value = pyJsonParse(candidate);
			if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof PyNumberLexeme)) {
				return value as Record<string, unknown>;
			}
		} catch {
			// next candidate
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The store side of one document

export interface StoreRegistry {
	get(root: string, tool: StoreTool): ChronoStore;
}

export function createRegistry(info: RunInfo): StoreRegistry & { closeAll(exitCode: number | undefined): void } {
	const stores = new Map<string, ChronoStore>();
	return {
		get(root, tool) {
			const key = `${tool}\u0000${root.toLowerCase()}`;
			let store = stores.get(key);
			if (!store) {
				store = ChronoStore.open(root, tool, info);
				stores.set(key, store);
			}
			return store;
		},
		closeAll(exitCode) {
			for (const store of stores.values()) {
				try {
					store.close(exitCode);
				} catch {
					// the leases expire on their own
				}
			}
			stores.clear();
		},
	};
}

interface Held {
	plan: StoreDocPlan;
	docId: number;
	lease: Lease;
	units: MappedUnit[];
	/** Rows as read when the document was planned or last written, by idx. */
	signatures: Map<number, string>;
}

export interface ExportResult {
	files: string[];
	warnings: string[];
	/** Files that could not be read or replaced (left as they were; the store marks them stale). */
	stale: string[];
	/** Files changed outside the tools (or not rendered from the store), left as they are without --force. */
	kept: string[];
	error?: string;
}

/** The document error for rendered files that were not replaced, so that the export is incomplete. */
export function staleError(stale: string[], kept: string[] = []): string {
	const parts = [
		...(stale.length > 0 ? [`could not replace ${stale.join(", ")}`] : []),
		...(kept.length > 0 ? [`kept ${kept.join(", ")}, changed outside the tool (--force replaces it)`] : []),
	];
	return `the rendered files are not current: ${parts.join("; ")}`;
}

export interface SyncOptions {
	mode: Mode;
	schema: LoadedSchema;
	force: boolean;
	model: { provider: string; model: string };
	/** --units of the run, recorded as ChronoMiner's chunk_slice. */
	units?: string;
	log: (message: string) => void;
	warn: (message: string) => void;
}

function splitModel(model: string | undefined): { provider: string; model: string } {
	if (!model) return { provider: "unknown", model: "unknown" };
	const slash = model.indexOf("/");
	return slash > 0
		? { provider: model.slice(0, slash), model: model.slice(slash + 1) }
		: { provider: "unknown", model };
}

/** The model of the session that finished a unit, else the run's. */
function unitModel(state: DocState, unit: UnitRecord, fallback: { provider: string; model: string }) {
	const session = unit.session !== undefined ? state.sessions[unit.session - 1] : undefined;
	return session?.model ? splitModel(session.model) : fallback;
}

/** The schema text as ChronoMiner reads it (`read_text`: UTF-8 with universal newlines). */
function schemaText(schema: LoadedSchema): string {
	return readFileSync(schema.path, "utf8").replace(/\r\n?/g, "\n");
}

export class ChronoSync {
	readonly plan: ChronoPlan;
	private readonly registry: StoreRegistry;
	private readonly options: SyncOptions;
	private store: ChronoStore | undefined;
	private held: Held[] = [];
	private schemaSha: string | undefined;

	constructor(plan: ChronoPlan, registry: StoreRegistry, options: SyncOptions) {
		this.plan = plan;
		this.registry = registry;
		this.options = options;
	}

	private schemaJson: unknown;

	/** The schema file's JSON, as ChronoMiner passes it to the entries writer. */
	private schemaFile(): unknown {
		this.schemaJson ??= JSON.parse(readFileSync(this.options.schema.path, "utf8").replace(/^﻿/, "")) as unknown;
		return this.schemaJson;
	}

	/** Store documents this run writes. */
	documentNames(): string[] {
		return this.held.map((held) => held.plan.name);
	}

	databasePath(): string | undefined {
		return this.store?.path;
	}

	/**
	 * The input identity ChronoTranscriber (listing hash) or ChronoMiner (file hash) records for a document, computed
	 * afresh on every call. Under the lease it must equal the one the preflight saw.
	 */
	private identity(document: StoreDocPlan, underLease = false): string {
		const identity =
			(this.plan.tool === "chronotranscriber"
				? inputIdentity(document.inputPath)
				: fileSha256(document.inputPath)) ?? undefined;
		if (!identity) throw new Error(`cannot compute the input identity of ${document.inputPath}`);
		const seen = this.identities.get(document.name);
		if (underLease && seen !== undefined && seen !== identity) {
			throw new Error(
				`the input of '${document.name}' (${document.inputPath}) changed while the run started (${seen.slice(0, 12)}..., now ${identity.slice(0, 12)}...); run again`,
			);
		}
		if (!underLease) this.identities.set(document.name, identity);
		return identity;
	}

	/** Identities the preflight computed, by document name. */
	private identities = new Map<string, string>();
	/** Leases taken by the preflight on documents already in the store, by document name. */
	private preleased = new Map<string, Lease>();

	/** The SHA-256 of the schema text as ChronoMiner records it in document_meta. */
	private currentSchemaSha(): string {
		this.schemaSha ??= textSha256(schemaText(this.options.schema));
		return this.schemaSha;
	}

	/**
	 * Refuse a store row that another run leases, that awaits a batch, or (without --force) holds another input or,
	 * for ChronoMiner, done chunks of another schema. Run first in the preflight and again under the lease.
	 */
	private checkRow(
		c: Connection,
		row: DocumentRow,
		document: StoreDocPlan,
		path: string,
		identity: () => string,
	): void {
		const store = this.registry.get(this.plan.root, this.plan.tool);
		const connection = c;
		if (store.blockedUnits(row.doc_id, connection).length > 0) {
			throw new Error(
				`units of '${document.name}' in ${path} await an open or unresolved batch submission; run the ${this.plan.tool} batch check first`,
			);
		}
		if (this.options.force) return;
		const current = identity();
		if (row.units_total > 0 && row.input_sha256 && row.input_sha256 !== current) {
			throw new Error(
				`the store document '${document.name}' in ${path} holds another input (stored ${row.input_sha256.slice(0, 12)}..., now ${current.slice(0, 12)}...); use --force to start it over, or write to another --out`,
			);
		}
		this.checkSchema(connection, row, document, path);
	}

	/** Refuse a ChronoMiner document whose done chunks were extracted with another schema (CM's classifier does). */
	private checkSchema(connection: Connection, row: DocumentRow, document: StoreDocPlan, path: string): void {
		if (this.plan.tool !== "chronominer") return;
		const read = <T>(sql: string, ...params: Array<string | number>): T | undefined =>
			connection.get(sql, ...params) as T | undefined;
		const stored = read<{ schema_sha256: string | null }>(
			"SELECT schema_sha256 FROM document_meta WHERE doc_id = ?",
			row.doc_id,
		)?.schema_sha256;
		const done = Number(
			read<{ n: number }>(
				"SELECT count(*) AS n FROM units WHERE doc_id = ? AND kind = 'chunk' AND status = 'done'",
				row.doc_id,
			)?.n ?? 0,
		);
		if (stored && stored !== this.currentSchemaSha() && done > 0) {
			throw new Error(
				`the store document '${document.name}' in ${path} has ${done} chunk(s) extracted with another schema (stored ${stored.slice(0, 12)}..., now ${this.currentSchemaSha().slice(0, 12)}...); use --force to extract it again, or write to another --out`,
			);
		}
	}

	/**
	 * Before any local file is deleted or changed: check and lease the store documents that exist already (leases,
	 * open batches, input identity, schema). Throws to refuse the document; no lease stays held then.
	 */
	preflight(): void {
		const { plan } = this;
		if (!existsSync(join(plan.root, DATABASE_NAMES[plan.tool]))) return;
		const store = this.registry.get(plan.root, plan.tool);
		try {
			for (const document of plan.documents) {
				const found = store.document(document.name);
				if (!found) continue;
				// The lease first: the row and its batches are read again under it, so nothing can change them between
				// these checks and the deletion --force may do next.
				const lease = store.acquire(found.doc_id);
				if (!lease) throw leasedError(store, found.doc_id, document.name);
				this.preleased.set(document.name, lease);
				store.leased(lease, (c) => {
					const row = c.get("SELECT * FROM documents WHERE doc_id = ?", found.doc_id) as unknown as DocumentRow;
					this.checkRow(c, row, document, store.path, () => this.identity(document));
				});
			}
		} catch (error) {
			this.releasePreleased(store);
			throw error;
		}
	}

	private releasePreleased(store: ChronoStore): void {
		for (const lease of this.preleased.values()) {
			try {
				store.release(lease);
			} catch {
				// expires on its own
			}
		}
		this.preleased.clear();
	}

	/**
	 * Before any agent work: check the store documents again under their leases (input identity, open batches,
	 * schema, unit layout), plan every unit as pending and adopt the done units another tool wrote. Throws to refuse
	 * the document; nothing is changed then (no lease stays held).
	 */
	start(state: DocState, paths: DocPaths, texts: { prompt: string; context: string[] }): void {
		const { options, plan } = this;
		const preflighted = this.preleased.size > 0 ? this.registry.get(plan.root, plan.tool) : undefined;
		let mapped: Map<string, MappedUnit[]>;
		try {
			mapped = mapUnits(plan, state, options.warn);
		} catch (error) {
			if (preflighted) this.releasePreleased(preflighted);
			throw error;
		}
		const candidates = plan.documents.filter((document) => mapped.has(document.name));
		if (candidates.length === 0) {
			if (preflighted) this.releasePreleased(preflighted);
			// Files rendered from the units alone (a single image, a multi-page TIFF) belong to no store document, so
			// they must not replace a file the store registers for one, also not under --force.
			const database = join(plan.root, DATABASE_NAMES[plan.tool]);
			if (plan.textOutputs && existsSync(database)) {
				const owned = registeredOwner(this.registry.get(plan.root, plan.tool), plan.textOutputs);
				if (owned) {
					throw new Error(
						`${owned.path} is a rendered file of the store document '${owned.name}' in ${database}, which this input cannot update (it has no store document of its own); set --out to write the files elsewhere`,
					);
				}
			}
			return;
		}
		this.store = this.registry.get(plan.root, plan.tool);
		const runId = this.store.run();
		const stamp = { runId, ...options.model };
		const leases: Held[] = [];
		try {
			for (const document of candidates) {
				let lease = this.preleased.get(document.name);
				this.preleased.delete(document.name);
				if (!lease) {
					const docId = this.store.ensureDocument(document.name, document.inputPath, document.kind);
					lease = this.store.acquire(docId);
					if (!lease) throw leasedError(this.store, docId, document.name);
				}
				const docId = lease.docId;
				const units = mapped.get(document.name) as MappedUnit[];
				leases.push({ plan: document, docId, lease, units, signatures: new Map() });
				this.store.leased(lease as Lease, (c) => this.prepare(c, document, docId, units, stamp));
			}
		} catch (error) {
			for (const held of leases) {
				try {
					this.store.release(held.lease);
				} catch {
					// expires on its own
				}
			}
			this.releasePreleased(this.store);
			throw error;
		}
		// Store documents of the preflight that hold none of the units (none in the current mapping) are let go.
		this.releasePreleased(this.store);
		this.held = leases;
		const store = this.store;
		store.storeArtifact("prompt", texts.prompt);
		this.schemaSha = store.storeArtifact("schema", schemaText(options.schema));
		for (const text of texts.context) store.storeArtifact("context", text);
		if (plan.tool === "chronominer") {
			for (const held of this.held) {
				store.leased(held.lease, (c) => this.writeMetadata(c, held, state));
			}
		}
		for (const held of this.held) this.adopt(state, paths, held);
	}

	private prepare(
		c: Connection,
		document: StoreDocPlan,
		docId: number,
		units: MappedUnit[],
		stamp: { runId: string; provider: string; model: string },
	): void {
		const store = this.store as ChronoStore;
		const planned = units.map((item) => item.planned);
		const kind = document.unitKind;
		// Computed again after the conversion, under the lease; it must be the one the preflight checked.
		const identity = this.identity(document, true);
		// The row as it is now, under the lease: the checks of the preflight hold, and only then is it changed.
		const row = c.get("SELECT * FROM documents WHERE doc_id = ?", docId) as unknown as DocumentRow;
		this.checkRow(c, row, document, store.path, () => identity);
		c.run("UPDATE documents SET input_path = ?, kind = ? WHERE doc_id = ?", document.inputPath, document.kind, docId);
		if (this.options.force) {
			if (this.plan.tool === "chronotranscriber") {
				ctForcedReplacement(c, docId, kind, planned, stamp, identity);
				return;
			}
			const stored = store.units(docId, "chunk");
			if (!sameLayout(stored, planned)) cmReplaceChunks(c, docId, planned, stamp);
			else {
				planUnits(c, docId, kind, planned, stamp);
				cmResetChunks(c, docId, stamp.runId);
			}
			recordIdentity(c, docId, identity);
			return;
		}
		refuseBlocking(c, docId);
		const all = c.all("SELECT * FROM units WHERE doc_id = ? ORDER BY kind, idx", docId) as unknown as UnitRow[];
		const problem = layoutProblem(this.plan.tool, all, kind, planned, document);
		if (problem) {
			throw new Error(
				`the store document '${document.name}' ${problem}; use --force to replace its units, or write to another --out`,
			);
		}
		recordIdentity(c, docId, identity);
		planUnits(c, docId, kind, planned, stamp);
	}

	private writeMetadata(c: Connection, held: Held, state: DocState): void {
		const last = state.sessions[state.sessions.length - 1];
		const model = last?.model ? splitModel(last.model).model : this.options.model.model;
		const text = held.plan.kind === "text";
		const values: Record<string, unknown> = {
			schema_name: this.options.schema.name,
			model_name: model,
			chunking_method: text
				? state.fingerprint.lineRanges || state.drafts?.ranges
					? "line_ranges"
					: "mabillon"
				: "pages",
			chunking_text_version: null,
			document_total_chunks: text ? held.units.length : null,
			chunk_slice: this.options.units ? { pages: this.options.units } : null,
			image_provenance: text
				? null
				: {
						source_file: basename(held.plan.inputPath),
						source_sha256: fileSha256(held.plan.inputPath) ?? null,
						renderer: "mabillon",
					},
		};
		writeMetadata(c, held.docId, values, this.schemaSha, (this.store as ChronoStore).run(), isoTime());
	}

	/** Take over the done units another tool wrote: their content becomes the committed copy, with no agent work. */
	private adopt(state: DocState, paths: DocPaths, held: Held): void {
		const store = this.store as ChronoStore;
		const rows = new Map(store.units(held.docId, held.plan.unitKind).map((row) => [row.idx, row]));
		let adopted = 0;
		for (const { unit, planned } of held.units) {
			const row = rows.get(planned.idx);
			if (!row) continue;
			held.signatures.set(planned.idx, unitSignature(row));
			// The store row is the current state. A finished unit whose row has changed since Mabillon last saw or wrote
			// it (run_id, status or the stale flag; a reset or forced replacement keeps the tool column) is worked again,
			// or adopted when another tool finished it; so is an adopted unit whose row is no longer done. The row as it
			// is now becomes the baseline of the next start, saved before any agent work.
			const usable = row.status === "done" && row.stale !== 1 && row.content !== null && row.tool !== "mabillon";
			const seen = unit.storeRow;
			const now = baseline(row);
			const changed =
				seen !== undefined && (seen.runId !== now.runId || seen.status !== now.status || seen.stale !== now.stale);
			unit.storeRow = now;
			// Correction mode: a drafted unit whose row changed since Mabillon last saw it (also one --redo-review set
			// to pending) is corrected again from its saved draft, never adopted.
			if (unit.draft && changed) {
				if (unit.status !== "pending") reopenUnit(unit);
				restoreDraft(paths, state, unit);
				continue;
			}
			// A drafted unit is worked by the agent, also when its draft is this store's done row, and so is one whose
			// draft could not be read or matched.
			if ((unit.draft || unit.draftRejected) && unit.status === "pending") continue;
			if (seen !== undefined && !unit.adopted && unit.status !== "pending") {
				if (seen.runId === now.runId && seen.status === now.status && seen.stale === now.stale) continue;
				// A corrected unit is never replaced by another tool's row: it is corrected again from its draft.
				if (!usable || unit.draft) {
					reopenUnit(unit);
					if (unit.draft) restoreDraft(paths, state, unit);
					continue;
				}
			} else if (unit.adopted && !usable) {
				reopenUnit(unit);
				continue;
			}
			if (!usable || row.content === null) continue;
			const content =
				this.options.mode === "transcribe"
					? adoptedTranscription(row.content, this.options.schema)
					: adoptedExtraction(row.content);
			writeFileAtomic(committedPath({ paths, mode: state.mode }, unit), content);
			writeFileAtomic(join(paths.workDir, unitFile(state.mode, unit)), content);
			unit.status = "committed";
			unit.contentHash = sha256Text(content);
			unit.issues = undefined;
			unit.closedReason = undefined;
			unit.carryOver = undefined;
			unit.committedAt = new Date().toISOString();
			unit.adopted = { tool: row.tool, runId: row.run_id, model: row.model, outcome: row.outcome ?? undefined };
			adopted++;
		}
		if (adopted > 0) {
			this.options.log(
				`${state.stem}: ${adopted} unit(s) of '${held.plan.name}' were done by another tool and are adopted`,
			);
		}
	}

	/** The row Mabillon writes for a unit, or "pending"/undefined (adopted: the row stays as the other tool wrote it). */
	private desired(state: DocState, paths: DocPaths, held: Held, item: MappedUnit): UnitWrite | "pending" | undefined {
		const { unit, planned } = item;
		if (unit.adopted) return undefined;
		const model = unitModel(state, unit, this.options.model);
		const kind = held.plan.unitKind;
		const base = { kind, idx: planned.idx, label: planned.label, sourceIndex: planned.sourceIndex, ...model };
		const provenance: Record<string, unknown> = {
			mabillon: { unit: unit.id, ...(unit.session ? { session: unit.session } : {}) },
		};
		if (unit.status === "pending") return "pending";
		const content = unit.status === "committed" ? readCanonical(paths, state.mode, unit) : undefined;
		if (unit.status === "committed" && content === undefined) return "pending";
		if (unit.status === "needs_review" || content === undefined) {
			return {
				...base,
				status: "failed",
				outcome: "failed",
				content: null,
				error: unit.closedReason ?? "closed for review",
				errorType: "needs_review",
				provenance:
					this.plan.tool === "chronominer" ? { ...this.cmProvenance(held, item), ...provenance } : provenance,
			};
		}
		if (this.plan.tool === "chronotranscriber") {
			const page = transcriptionContent(content, this.options.schema);
			return { ...base, status: "done", ...page, provenance };
		}
		const data = parseAnswer(content);
		const outcome = data?.contains_no_content_of_requested_type === true ? "no_content" : data ? "ok" : "unparsed";
		return {
			...base,
			status: "done",
			outcome,
			content,
			provenance: { ...this.cmProvenance(held, item), ...provenance },
		};
	}

	private cmProvenance(held: Held, item: MappedUnit): Record<string, unknown> {
		const stem = pyStem(basename(held.plan.inputPath));
		if (held.plan.kind === "text") {
			return {
				custom_id: buildCustomId(stem, `-chunk-${item.planned.idx + 1}`),
				chunk_range: [item.unit.startLine, item.unit.endLine],
			};
		}
		return {
			custom_id: buildCustomId(stem, `-page-${item.planned.idx + 1}`),
			chunk_range: null,
			image_provenance: {
				source_file: basename(held.plan.inputPath),
				...(item.unit.pdfPage ? { page_index: item.unit.pdfPage - 1 } : {}),
				renderer: "mabillon",
			},
		};
	}

	/**
	 * After the agent work (also after an error or interruption): write the changed units, the entries and metadata,
	 * and the rendered files in one leased transaction per store document, then release the leases.
	 */
	export(state: DocState, paths: DocPaths): ExportResult {
		const result: ExportResult = { files: [], warnings: [], stale: [], kept: [] };
		const store = this.store;
		if (!store) return result;
		const errors: string[] = [];
		for (const held of this.held) {
			const report = emptyReport();
			try {
				store.leased(held.lease, (c) => this.write(c, held, state, paths, report));
				// A committed export moves the baseline of the next start to the rows as written.
				const rows = new Map(store.units(held.docId, held.plan.unitKind).map((row) => [row.idx, row]));
				for (const { unit, planned } of held.units) {
					const row = rows.get(planned.idx);
					if (row) unit.storeRow = baseline(row);
				}
			} catch (error) {
				errors.push(`${held.plan.name}: ${(error as Error).message}`);
			}
			result.files.push(...report.written, ...report.unchanged);
			result.warnings.push(...report.warnings);
			result.stale.push(...report.stale);
			result.kept.push(...report.kept);
		}
		if (errors.length > 0) result.error = `the store was not updated (${errors.join("; ")})`;
		else if (result.stale.length > 0 || result.kept.length > 0) result.error = staleError(result.stale, result.kept);
		return result;
	}

	/** Release the leases (the store stays open for the run). */
	release(): void {
		if (this.preleased.size > 0) this.releasePreleased(this.registry.get(this.plan.root, this.plan.tool));
		for (const held of this.held) {
			try {
				this.store?.release(held.lease);
			} catch {
				// expires on its own
			}
		}
	}

	private write(c: Connection, held: Held, state: DocState, paths: DocPaths, report: RenderReport): void {
		const store = this.store as ChronoStore;
		const runId = store.run();
		refuseBlocking(c, held.docId);
		const rows = new Map(
			(
				c.all(
					"SELECT * FROM units WHERE doc_id = ? AND kind = ?",
					held.docId,
					held.plan.unitKind,
				) as unknown as UnitRow[]
			).map((row) => [row.idx, row]),
		);
		for (const { planned } of held.units) {
			const row = rows.get(planned.idx);
			const before = held.signatures.get(planned.idx);
			if (row && before !== undefined && unitSignature(row) !== before) {
				throw new Error(
					`unit ${planned.idx} was changed in the store by run ${row.run_id} (${row.tool}) while Mabillon worked on the document`,
				);
			}
		}
		for (const item of held.units) {
			const row = rows.get(item.planned.idx);
			const want = this.desired(state, paths, held, item);
			if (want === undefined) continue;
			// Correction mode: a done row of the output store (a draft, or another tool's or document's work) is
			// replaced only by a unit that commits; a failed attempt is reported in the state and the sidecar only.
			if (state.drafts && item.unit.status !== "committed" && row?.status === "done") continue;
			if (want === "pending") {
				if (row && row.tool === "mabillon" && row.status !== "pending") {
					c.run(
						"UPDATE units SET status = 'pending', outcome = NULL, content = NULL, usage = NULL, error = NULL, error_type = NULL, provenance = NULL, response_id = NULL, attempts = 0, stale = 0, run_id = ?, updated_at = ? WHERE doc_id = ? AND kind = ? AND idx = ?",
						runId,
						isoTime(),
						held.docId,
						held.plan.unitKind,
						item.planned.idx,
					);
					if (this.plan.tool === "chronominer") {
						c.run(
							"DELETE FROM entry_rows WHERE doc_id = ? AND kind = 'chunk' AND idx = ?",
							held.docId,
							item.planned.idx,
						);
					}
					c.run("UPDATE outputs SET stale = 1 WHERE doc_id = ? AND stale = 0", held.docId);
					refreshDocument(c, held.docId, runId);
				}
				continue;
			}
			if (row && sameRow(row, want)) continue;
			if (this.plan.tool === "chronominer") {
				const data = want.status === "done" && want.content !== null ? parseAnswer(want.content) : undefined;
				const entries =
					data && data.contains_no_content_of_requested_type !== true && Array.isArray(data.entries)
						? (data.entries as unknown[]).filter(
								(entry): entry is Record<string, unknown> =>
									!!entry && typeof entry === "object" && !Array.isArray(entry),
							)
						: [];
				writeEntries(c, held.docId, item.planned.idx, entries, {
					schema: this.schemaFile(),
					schemaName: this.options.schema.name,
					runId,
					model: want.model,
					provider: want.provider,
				});
			}
			writeUnit(c, held.docId, want, runId);
		}
		if (this.plan.tool === "chronominer") this.writeMetadata(c, held, state);
		const count = renderedUnitCount(c, held.docId, this.plan.tool === "chronominer" ? "chunk" : undefined);
		if (count > 0) {
			const targets: RenderTarget[] = held.plan.outputs.map((output) => ({
				path: output.path,
				format: output.format,
				text:
					this.plan.tool === "chronotranscriber"
						? renderDocument(c, held.docId, output.format as TextFormat)
						: output.format === "csv"
							? renderCsv(c, held.docId)
							: renderOutputJson(c, held.docId),
			}));
			const recorded = recordedOutputs(c, held.docId);
			writeGuarded(
				targets,
				(path) => recorded.get(store.pathKey(path)),
				this.options.force,
				(target, sha, ok) => recordOutput(c, held.docId, store.pathKey(target.path), target.format, sha, ok, runId),
				report,
			);
		}
		for (const row of c.all(
			"SELECT * FROM units WHERE doc_id = ? AND kind = ?",
			held.docId,
			held.plan.unitKind,
		) as unknown as UnitRow[]) {
			held.signatures.set(row.idx, unitSignature(row));
		}
	}
}

function baseline(row: UnitRow): { status: string; stale: number; runId: string } {
	return { status: row.status, stale: Number(row.stale), runId: row.run_id };
}

/** The first of `outputs` that the store registers for any of its documents, with that document's name. */
function registeredOwner(
	store: ChronoStore,
	outputs: Array<{ path: string }>,
): { path: string; name: string } | undefined {
	for (const output of outputs) {
		const row = store.connection.get(
			"SELECT d.name FROM outputs AS o JOIN documents AS d ON d.doc_id = o.doc_id WHERE o.path = ?",
			store.pathKey(output.path),
		);
		if (row) return { path: output.path, name: String(row.name) };
	}
	return undefined;
}

/** Correction mode: put the seeded draft (its immutable copy in run/drafts/) back into the unit file. */
function restoreDraft(paths: DocPaths, state: DocState, unit: UnitRecord): void {
	const copy = join(paths.runDir, "drafts", unitFile(state.mode, unit));
	if (existsSync(copy)) writeFileAtomic(join(paths.workDir, unitFile(state.mode, unit)), readFileSync(copy, "utf8"));
}

/** A finished unit that the store no longer holds as done goes back to pending (its committed copy is ignored). */
function reopenUnit(unit: UnitRecord): void {
	// The fields reopenDamaged and --redo-review reset, so the new attempt starts with no stops or cap records.
	Object.assign(unit, {
		status: "pending",
		adopted: undefined,
		contentHash: undefined,
		committedAt: undefined,
		closedReason: undefined,
		issues: undefined,
		carryOver: undefined,
		toolCalls: 0,
		views: 0,
		verifyRuns: 0,
		stops: 0,
		rejections: undefined,
		softCapBlocks: undefined,
		hardCapClosed: undefined,
		session: undefined,
	});
}

function leasedError(store: ChronoStore, docId: number, name: string): Error {
	const current = store.documentById(docId);
	const until = current?.lease_until ? new Date(Number(current.lease_until) * 1000).toISOString() : "unknown";
	return new Error(
		`'${name}' in ${store.path} is leased by run ${current?.lease_run_id ?? "unknown"} until ${until}; wait for that run to finish`,
	);
}

/** ChronoMiner's `build_custom_id`: a provider-safe id of a file stem and an ordering suffix. */
export function buildCustomId(stem: string, suffix: string): string {
	const sanitized = stem.replace(/[^A-Za-z0-9_-]/gu, "_");
	const digest = sha256Text(stem).slice(0, 8);
	const base = sanitized === stem ? sanitized : `${sanitized}_${digest}`;
	const candidate = `${base}${suffix}`;
	if ([...candidate].length <= 64) return candidate;
	const keep = Math.max(64 - [...suffix].length - 8 - 1, 0);
	return `${[...sanitized].slice(0, keep).join("")}_${digest}${suffix}`;
}

/** Whether stored chunk units fit the planned ones (`_same_layout`; an unplaced unit fits any). */
function sameLayout(stored: UnitRow[], planned: PlannedUnit[]): boolean {
	return (
		stored.length === planned.length &&
		stored.every(
			(unit, i) =>
				unit.idx === planned[i].idx &&
				(unit.source_index === null || String(unit.source_index) === String(planned[i].sourceIndex)),
		)
	);
}

/** Why a stored document's units do not fit the planned ones (another chunk layout, other pages), or undefined. */
function layoutProblem(
	tool: StoreTool,
	all: UnitRow[],
	kind: string,
	planned: PlannedUnit[],
	document: StoreDocPlan,
): string | undefined {
	if (all.length === 0) return undefined;
	// ChronoMiner's range units (line-range adjustment) live beside the chunks; ChronoTranscriber's other kinds
	// (native text, audio chunks) replace the pages.
	const others = tool === "chronotranscriber" ? all.filter((row) => row.kind !== kind) : [];
	if (others.length > 0) return `holds units of kind ${[...new Set(others.map((row) => row.kind))].join(", ")}`;
	const stored = all.filter((row) => row.kind === kind);
	if (stored.length === 0) return undefined;
	if (tool === "chronominer") {
		return sameLayout(stored, planned)
			? undefined
			: `holds chunks cut with other line ranges or pages (${stored.length} stored, ${planned.length} now)`;
	}
	const wanted = new Set(planned.map((unit) => unit.idx));
	if (stored.length !== planned.length || stored.some((row) => !wanted.has(row.idx))) {
		return `holds ${stored.length} page(s), the input has ${planned.length}`;
	}
	if (document.kind === "images") {
		const images = listFolderImages(document.inputPath);
		for (const row of stored) {
			const label = row.label ?? "";
			const image = basename(images[row.idx] ?? "");
			const known = label.endsWith("_pre_processed.jpg") || label.includes("_tess_preprocessed.");
			const fits = labelNamesImage(label, image);
			if (known && !fits) return `stores page ${row.idx + 1} as ${label}, which is not ${image}`;
		}
	}
	return undefined;
}

function sameRow(row: UnitRow, want: UnitWrite): boolean {
	return (
		row.tool === "mabillon" &&
		row.status === want.status &&
		row.outcome === want.outcome &&
		row.content === want.content &&
		row.label === want.label &&
		String(row.source_index) === String(want.sourceIndex) &&
		row.model === want.model &&
		row.provider === want.provider &&
		(row.error ?? null) === (want.error ?? null) &&
		row.provenance === (want.provenance ? jsonText(want.provenance) : null)
	);
}

function jsonText(value: Record<string, unknown>): string {
	return pyJsonDumps(value);
}

/**
 * A unit file for a page another tool transcribed: the schema's flags in the front matter, its text as the body.
 * Required fields the store has no value for (such as `image_analysis`) get the empty value of their type, so the
 * page validates.
 */
export function adoptedTranscription(content: string, schema: LoadedSchema): string {
	const properties = (schema.schema.properties ?? {}) as Record<string, { type?: string | string[] }>;
	const cause = detectCause(content);
	const flags: string[] = [];
	if ("no_transcribable_text" in properties) flags.push(`no_transcribable_text: ${cause === "no_text"}`);
	if ("transcription_not_possible" in properties)
		flags.push(`transcription_not_possible: ${cause === "not_possible"}`);
	const known = new Set([
		"no_transcribable_text",
		"transcription_not_possible",
		schema.rules.bodyField ?? "transcription",
	]);
	for (const name of (schema.schema.required ?? []) as string[]) {
		if (known.has(name)) continue;
		const types = [properties[name]?.type ?? []].flat();
		if (types.includes("string")) flags.push(`${name}: ""`);
		else if (types.includes("boolean")) flags.push(`${name}: false`);
		else if (types.includes("null")) flags.push(`${name}: null`);
	}
	const body = cause === "ok" ? pyStrip(content) : "";
	return `---\n${flags.join("\n")}${flags.length > 0 ? "\n" : ""}---\n${body}${body ? "\n" : ""}`;
}

/** A unit file for a chunk another tool extracted: its answer's JSON object, indented. */
export function adoptedExtraction(content: string): string {
	const data = parseAnswer(content);
	return data ? `${JSON.stringify(data, null, 2)}\n` : content;
}

/** Whether a ChronoTranscriber page label (`<image>_pre_processed.jpg`, tesseract variants) names `image`. */
export function labelNamesImage(label: string, image: string): boolean {
	const name = basename(image);
	const stem = pyStem(name);
	return (
		label === `${name}_pre_processed.jpg` ||
		label.startsWith(`${stem}_tess_preprocessed.`) ||
		label.startsWith(`${name}_tess_preprocessed.`)
	);
}

/**
 * The text files of a transcription without a store row, rendered from its units as ChronoTranscriber would render
 * them, with the same overwrite guard; `recorded` holds the hashes of the files the last export wrote.
 */
export function renderWithoutStore(
	plan: ChronoPlan,
	state: DocState,
	paths: DocPaths,
	schema: LoadedSchema,
	recorded: Record<string, string>,
	force: boolean,
): { report: RenderReport; hashes: Record<string, string> } {
	const report = emptyReport();
	const hashes: Record<string, string> = {};
	if (!plan.textOutputs) return { report, hashes };
	const units: RenderUnit[] = [];
	for (const unit of state.units) {
		if (unit.status === "pending") continue;
		const label = unit.pdfPage
			? `page_${pad4(unit.pdfPage)}_pre_processed.jpg`
			: `${basename(unit.image ?? unit.id)}${unit.imagePage ? `_${unit.imagePage + 1}` : ""}_pre_processed.jpg`;
		const content = unit.status === "committed" ? readCanonical(paths, state.mode, unit) : undefined;
		units.push({
			kind: "page",
			idx: unit.index - 1,
			status: content === undefined ? "failed" : "done",
			label,
			content: content === undefined ? null : transcriptionContent(content, schema).content,
		});
	}
	if (units.length === 0) return { report, hashes };
	const targets = plan.textOutputs.map((output) => ({
		path: output.path,
		format: output.format,
		text: renderUnits(units, null, output.format as TextFormat),
	}));
	writeGuarded(
		targets,
		(path) => recorded[path],
		force,
		(target, sha, ok) => {
			if (ok && sha) hashes[target.path] = sha;
		},
		report,
	);
	return { report, hashes };
}

export { documentMetadata, splitModel };
