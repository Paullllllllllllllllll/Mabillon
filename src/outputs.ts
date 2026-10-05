import { join, relative } from "node:path";
import { readCommitted } from "./agent/runtime.ts";
import { type DocPaths, type DocState, isDone, type UnitRecord } from "./agent/state.ts";
import { envelopeInfo, type LoadedSchema } from "./schemas/registry.ts";
import { implementationFingerprint, readPackageVersion, writeFileAtomic, writeJson } from "./util.ts";
import { formatIssue } from "./verify/issues.ts";
import { parseTranscriptionUnit } from "./verify/rules.ts";
import { verifyObject } from "./verify/verify.ts";

export interface RunMetadata {
	mabillon_version: string;
	mode: DocState["mode"];
	input_kind: DocState["inputKind"];
	source: string;
	schema: { name: string; sha256: string; path: string };
	/** Top-level fields whose values differ between units (e.g. a running city heading); see the provenance. */
	varying_fields?: string[];
	model?: string;
	thinking?: string;
	/** The agent's tools in the latest session. */
	tools?: string[];
	/** The Mabillon build: package version, and the git commit (and uncommitted changes) of a checkout. */
	implementation: { version: string; commit?: string; dirty?: boolean };
	/** The experiment arm: tools, resolved settings, context file hashes, boundary policy, system-prompt hash. */
	experiment?: DocState["experiment"];
	/** Per session: model, thinking, tools and image profile. */
	session_settings: Array<{
		session: number;
		model?: string;
		thinking?: string;
		tools?: string[];
		image_profile?: string;
		/** OpenRouter provider preferences sent with the session's requests. */
		routing?: Record<string, unknown>;
		/** Upstream providers that served the session's requests (OpenRouter). */
		served_by?: string[];
	}>;
	/** Image fidelity downgrades after the provider rejected an image request. */
	image_fallbacks?: DocState["imageFallbacks"];
	/** Source lines in no unit, accepted with allow_partial_ranges. */
	uncovered_lines?: string[];
	/** Units closed because the tool budget ran out (censored), and units that hit the inspection (soft) cap. */
	units_closed_by_hard_cap: number;
	units_with_soft_cap_blocks: number;
	units_total: number;
	units_committed: number;
	units_needs_review: number;
	units_pending: number;
	/** Every unit of the document is finished (committed or closed for review). */
	complete: boolean;
	/** Present when the run was limited with --units: the selected units and whether all of them are finished. */
	selection?: { units: number; unit_ids: string[]; complete: boolean };
	needs_review: Array<{ unit: string; reason?: string; issues?: string[] }>;
	/** Warnings remaining on finished units (each page or unit record lists its own under `issues`). */
	warnings: number;
	units_with_warnings: number;
	/** Finished units whose committed copy is missing or changed; their content is not exported. */
	integrity_errors?: Array<{ unit: string; error: string }>;
	tokens: { input: number; output: number; cache_read: number };
	cost: number;
	sessions: number;
	created_at: string;
	updated_at: string;
	final_validation?: string[];
}

function buildMetadata(state: DocState, schema: LoadedSchema, selected: (index: number) => boolean): RunMetadata {
	const sessions = state.sessions;
	const last = sessions[sessions.length - 1];
	const committed = state.units.filter((unit) => unit.status === "committed").length;
	const review = state.units.filter((unit) => unit.status === "needs_review");
	const pending = state.units.filter((unit) => !isDone(unit)).length;
	const inSelection = state.units.filter((unit) => selected(unit.index));
	const warningCounts = state.units
		.filter(isDone)
		.map((unit) => unit.issues?.filter((issue) => issue.severity === "warning").length ?? 0);
	const metadata: RunMetadata = {
		mabillon_version: readPackageVersion(),
		mode: state.mode,
		input_kind: state.inputKind,
		source: state.source,
		schema: { name: schema.name, sha256: schema.sha256, path: schema.path },
		model: last?.model,
		thinking: last?.thinking,
		tools: state.tools,
		implementation: implementationFingerprint(),
		...(state.experiment ? { experiment: state.experiment } : {}),
		session_settings: sessions.map((session, index) => ({
			session: index + 1,
			model: session.model,
			thinking: session.thinking,
			tools: session.tools,
			image_profile: session.imageProfile,
			...(session.routing ? { routing: session.routing } : {}),
			...(session.servedBy?.length ? { served_by: session.servedBy } : {}),
		})),
		...(state.imageFallbacks?.length ? { image_fallbacks: state.imageFallbacks } : {}),
		...(state.uncoveredLines?.length ? { uncovered_lines: state.uncoveredLines } : {}),
		units_closed_by_hard_cap: state.units.filter((unit) => unit.hardCapClosed).length,
		units_with_soft_cap_blocks: state.units.filter((unit) => (unit.softCapBlocks ?? 0) > 0).length,
		units_total: state.units.length,
		units_committed: committed,
		units_needs_review: review.length,
		units_pending: pending,
		complete: pending === 0,
		needs_review: review.map((unit) => ({
			unit: unit.id,
			reason: unit.closedReason,
			issues: unit.issues?.filter((issue) => issue.severity === "error").map(formatIssue),
		})),
		warnings: warningCounts.reduce((sum, count) => sum + count, 0),
		units_with_warnings: warningCounts.filter((count) => count > 0).length,
		tokens: {
			input: sessions.reduce((sum, session) => sum + (session.inputTokens ?? 0), 0),
			output: sessions.reduce((sum, session) => sum + (session.outputTokens ?? 0), 0),
			cache_read: sessions.reduce((sum, session) => sum + (session.cacheReadTokens ?? 0), 0),
		},
		cost: Number(sessions.reduce((sum, session) => sum + (session.cost ?? 0), 0).toFixed(6)),
		sessions: sessions.length,
		created_at: state.createdAt,
		updated_at: new Date().toISOString(),
	};
	if (inSelection.length < state.units.length) {
		metadata.selection = {
			units: inSelection.length,
			unit_ids: inSelection.map((unit) => unit.id),
			complete: inSelection.every(isDone),
		};
	}
	return metadata;
}

/** A damaged committed copy makes the export incomplete, whatever the unit's status says. */
function recordIntegrity(metadata: RunMetadata, records: Array<Record<string, unknown>>): void {
	const damaged = records
		.filter((record) => typeof record.integrity_error === "string")
		.map((record) => ({ unit: record.unit as string, error: record.integrity_error as string }));
	if (damaged.length === 0) return;
	metadata.integrity_errors = damaged;
	metadata.complete = false;
	if (metadata.selection) metadata.selection.complete = false;
}

/**
 * The canonical (committed) content of a finished unit. A copy that is missing or changed since the unit was
 * finished is not exported; the record gets an `integrity_error` instead. The driver reopens such units before
 * exporting, so this only catches changes made in between.
 */
function committedContent(
	paths: DocPaths,
	state: DocState,
	unit: UnitRecord,
	record: Record<string, unknown>,
): string | undefined {
	const { content, problem } = readCommitted({ paths, mode: state.mode }, unit);
	if (problem) record.integrity_error = problem;
	return content;
}

/** Remaining issues of a finished unit (warnings of committed units, errors and warnings of reviewed ones). */
function unitIssues(unit: UnitRecord): Array<Record<string, unknown>> | undefined {
	if (!isDone(unit) || !unit.issues?.length) return undefined;
	return unit.issues.map((issue) => ({
		severity: issue.severity,
		layer: issue.layer,
		...(issue.pointer ? { location: issue.pointer } : {}),
		message: issue.message,
	}));
}

function location(state: DocState, unit: UnitRecord): Record<string, unknown> {
	if (state.inputKind === "text") return { lines: [unit.startLine, unit.endLine] };
	const where: Record<string, unknown> = { page: unit.index };
	if (unit.pdfPage) where.pdf_page = unit.pdfPage;
	if (unit.image) where.source_image = unit.image;
	if (unit.imagePage !== undefined) where.image_page = unit.imagePage;
	return where;
}

/** How a unit was produced: the session that finished it and whether the tool budget shaped it. */
function runInfo(unit: UnitRecord): Record<string, unknown> {
	return {
		...(unit.session !== undefined ? { session: unit.session } : {}),
		...(unit.hardCapClosed ? { hard_cap_closed: true } : {}),
		...(unit.softCapBlocks ? { soft_cap_blocks: unit.softCapBlocks } : {}),
	};
}

export interface OutputPaths {
	json: string;
	markdown?: string;
	provenance?: string;
}

function writeTranscription(
	paths: DocPaths,
	state: DocState,
	schema: LoadedSchema,
	selected: (index: number) => boolean,
): OutputPaths {
	const bodyField = schema.rules.bodyField ?? "transcription";
	const pages: Array<Record<string, unknown>> = [];
	const markdown: string[] = [];
	for (const unit of state.units) {
		const page: Record<string, unknown> = {
			unit: unit.id,
			status: unit.status,
			...location(state, unit),
			...runInfo(unit),
		};
		if (unit.closedReason) page.closed_reason = unit.closedReason;
		const issues = unitIssues(unit);
		if (issues) page.issues = issues;
		const content = committedContent(paths, state, unit, page);
		const parsed = content === undefined ? undefined : parseTranscriptionUnit(content, schema);
		if (parsed?.data) {
			Object.assign(page, parsed.data);
		} else if (parsed?.body !== undefined) {
			// Front matter that does not parse (only possible for units closed for review): keep the text.
			page[bodyField] = parsed.body;
			page.parse_error = parsed.issues.map(formatIssue).join("; ");
		}
		pages.push(page);
		if (!isDone(unit)) continue;
		markdown.push(`<!-- page ${unit.index} (${unit.id})${unit.status === "needs_review" ? " needs review" : ""} -->`);
		const data = parsed?.data;
		if (data?.no_transcribable_text === true) {
			markdown.push("[No transcribable text]");
		} else if (data?.transcription_not_possible === true) {
			markdown.push("[Transcription not possible]");
		} else if (data && typeof data[bodyField] === "string") {
			markdown.push(data[bodyField] as string);
		} else if (parsed?.body) {
			markdown.push(parsed.body);
		} else if (page.integrity_error) {
			markdown.push(`[Transcription not exported: ${page.integrity_error}]`);
		} else {
			markdown.push("[Transcription missing]");
		}
	}
	const out: OutputPaths = {
		json: join(paths.docDir, `${state.stem}.json`),
		markdown: join(paths.docDir, `${state.stem}.md`),
	};
	const metadata = buildMetadata(state, schema, selected);
	recordIntegrity(metadata, pages);
	writeJson(out.json, { mabillon: metadata, pages });
	writeFileAtomic(out.markdown as string, markdown.length > 0 ? `${markdown.join("\n\n")}\n` : "");
	return out;
}

function writeExtraction(
	paths: DocPaths,
	state: DocState,
	schema: LoadedSchema,
	selected: (index: number) => boolean,
): ExportResult {
	const info = envelopeInfo(schema.schema);
	const metadata = buildMetadata(state, schema, selected);
	const provenanceEntries: Array<Record<string, unknown>> = [];
	const provenanceUnits: Array<Record<string, unknown>> = [];
	const unitObjects: Array<{ unit: UnitRecord; data: Record<string, unknown>; record: Record<string, unknown> }> = [];
	for (const unit of state.units) {
		const record: Record<string, unknown> = {
			unit: unit.id,
			status: unit.status,
			...location(state, unit),
			...runInfo(unit),
		};
		if (unit.carryOver) record.carry_over = unit.carryOver;
		if (unit.closedReason) record.closed_reason = unit.closedReason;
		const issues = unitIssues(unit);
		if (issues) record.issues = issues;
		provenanceUnits.push(record);
		const content = committedContent(paths, state, unit, record);
		if (content === undefined) {
			if (isDone(unit) && !record.integrity_error) record.error = "no unit file";
			continue;
		}
		try {
			const data = JSON.parse(content) as unknown;
			if (data && typeof data === "object" && !Array.isArray(data)) {
				unitObjects.push({ unit, data: data as Record<string, unknown>, record });
			} else {
				record.error = "unit file is not a JSON object";
			}
		} catch {
			record.error = "unit file is not valid JSON";
		}
	}

	const out: OutputPaths = {
		json: join(paths.docDir, `${state.stem}.json`),
		provenance: join(paths.docDir, `${state.stem}.provenance.json`),
	};
	let merged: unknown;
	if (info.entriesField) {
		const entriesField = info.entriesField;
		const entries: unknown[] = [];
		const entryUnits: Array<Record<string, unknown>> = [];
		const result: Record<string, unknown> = {};
		for (const { unit, data, record } of unitObjects) {
			const unitEntries = data[entriesField];
			const count = Array.isArray(unitEntries) ? unitEntries.length : 0;
			record.entries = count;
			if (Array.isArray(unitEntries)) {
				for (const entry of unitEntries) {
					provenanceEntries.push({
						index: entries.length,
						unit: unit.id,
						status: unit.status,
						...location(state, unit),
					});
					entries.push(entry);
					entryUnits.push(data);
				}
			}
			// Other top-level fields: the merged output takes the first non-null value; every unit's own values are
			// kept in the provenance.
			const fields: Record<string, unknown> = {};
			for (const key of info.otherFields) {
				if (!(key in data)) continue;
				fields[key] = data[key];
				if ((result[key] === undefined || result[key] === null) && data[key] !== undefined) result[key] = data[key];
			}
			if (Object.keys(fields).length > 0) record.fields = fields;
		}
		for (const key of info.otherFields) if (!(key in result)) result[key] = null;
		// Fields that change from unit to unit (a page's city, section, or date) describe the entries of their unit;
		// the merged object can hold only one value, so each provenance entry records its unit's values.
		const varying = info.otherFields.filter((key) => {
			// null (or a missing field) is a value of its own: PARIS on one page and null on the next varies.
			const values = new Set(unitObjects.map(({ data }) => JSON.stringify(data[key] ?? null)));
			return values.size > 1;
		});
		if (varying.length > 0) {
			metadata.varying_fields = varying;
			provenanceEntries.forEach((entry, index) => {
				entry.unit_fields = Object.fromEntries(varying.map((key) => [key, entryUnits[index][key] ?? null]));
			});
		}
		if (info.emptyFlag) result[info.emptyFlag] = entries.length === 0;
		result[entriesField] = entries;
		// Keep the schema's property order for readability.
		const order = Object.keys((schema.schema.properties ?? {}) as object);
		merged = Object.fromEntries(order.filter((key) => key in result).map((key) => [key, result[key]]));
		const validation = verifyObject(schema, merged);
		const errors = validation.issues.filter((issue) => issue.severity === "error");
		if (errors.length > 0) metadata.final_validation = errors.map(formatIssue);
	} else {
		merged = unitObjects.map(({ unit, data }) => ({ unit: unit.id, data }));
	}
	recordIntegrity(metadata, provenanceUnits);
	writeJson(out.json, merged);
	writeJson(out.provenance as string, {
		mabillon: metadata,
		work_dir: relative(paths.docDir, paths.workDir),
		entries: provenanceEntries,
		units: provenanceUnits,
	});
	return metadata.final_validation ? { ...out, finalValidation: metadata.final_validation } : out;
}

export interface ExportResult extends OutputPaths {
	/** Schema errors of the merged extraction output (also in the provenance metadata as final_validation). */
	finalValidation?: string[];
}

/** Assemble the final outputs of a document from the committed copies of its finished units. */
export function writeOutputs(
	paths: DocPaths,
	state: DocState,
	schema: LoadedSchema,
	selected: (index: number) => boolean = () => true,
): ExportResult {
	return state.mode === "transcribe"
		? writeTranscription(paths, state, schema, selected)
		: writeExtraction(paths, state, schema, selected);
}
