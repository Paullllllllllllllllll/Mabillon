import { PyNumberLexeme, pyCasefold, pyJsonDumps, pyJsonParse, pyNumber } from "./py.ts";
import { type Connection, type Param, Real } from "./sqlite.ts";
import { createEntriesView } from "./store.ts";

/**
 * The ChronoMiner views of a document, ported from CM `output/output_json.py` (`{stem}_output.json`),
 * `output/csv_view.py` (`{stem}_output.csv`) and `output/entries.py` (the `entry_rows` table with its `f_<field>`
 * columns and the `entries` view).
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

const METADATA_KEY = "_chronominer_metadata";
const PAGE_KINDS = new Set(["pdf", "image", "images"]);
const COMPUTED = ["total_chunks", "partial", "failed_chunks", "version"];
const LEADING = ["schema_name", "model_name", "chunking_method"];
const OPTIONAL = ["chunking_text_version", "document_total_chunks", "chunk_slice"];

/** Python truthiness of a JSON value. */
function truthy(value: Json): boolean {
	if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
	if (value instanceof PyNumberLexeme) return value.value !== 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value as object).length > 0;
	return true;
}

function isObject(value: Json): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof PyNumberLexeme);
}

/** `json.loads` of a stored column, keeping the Python numbers of rows another tool wrote (`1.0`). */
function loads(value: unknown): Json {
	if (typeof value !== "string") return value ?? null;
	try {
		return pyJsonParse(value);
	} catch {
		return null;
	}
}

/** `document_metadata`: the stored run metadata and the SHA-256 of the schema text. */
export function documentMetadata(
	connection: Connection,
	docId: number,
): { metadata: JsonObject; schemaSha256?: string } {
	const row = connection.get("SELECT metadata, schema_sha256 FROM document_meta WHERE doc_id = ?", docId);
	if (!row) return { metadata: {} };
	const value = loads(row.metadata);
	return {
		metadata: isObject(value) ? value : {},
		...(row.schema_sha256 !== null && row.schema_sha256 !== undefined
			? { schemaSha256: String(row.schema_sha256) }
			: {}),
	};
}

/** `metadata_writer`: merge `values` into the document's run metadata; a null value removes its key. */
export function writeMetadata(
	connection: Connection,
	docId: number,
	values: JsonObject,
	schemaSha256: string | undefined,
	runId: string,
	now: string,
): void {
	const current = documentMetadata(connection, docId);
	const merged: JsonObject = { ...current.metadata, ...JSON.parse(pyJsonDumps(values)) };
	const kept = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null && value !== undefined));
	connection.run(
		"INSERT INTO document_meta (doc_id, metadata, schema_sha256, run_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (doc_id) DO UPDATE SET metadata = excluded.metadata, schema_sha256 = excluded.schema_sha256, run_id = excluded.run_id, updated_at = excluded.updated_at",
		docId,
		pyJsonDumps(kept),
		schemaSha256 ?? current.schemaSha256 ?? null,
		runId,
		now,
	);
}

/** The custom id of a chunk that stored none (`default_custom_id`). */
function defaultCustomId(name: string, kind: string | null, chunkIndex: number): string {
	const stem = name.split("/").pop() ?? name;
	return `${stem}-${kind !== null && PAGE_KINDS.has(kind) ? "page" : "chunk"}-${chunkIndex}`;
}

function chunkRange(provenance: JsonObject, sourceIndex: unknown): Json {
	if ("chunk_range" in provenance) return provenance.chunk_range;
	if (typeof sourceIndex === "string") {
		const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(sourceIndex);
		if (match) return [Number(match[1]), Number(match[2])];
	}
	return null;
}

function response(content: string, provenance: JsonObject, usage: Json, model: string, provider: string): JsonObject {
	const stored = provenance.response;
	if (isObject(stored)) return { output_text: content, ...stored };
	const data: JsonObject = {};
	if (truthy(usage)) data.usage = usage;
	data.model = model;
	data.provider = provider;
	return { output_text: content, response_data: data, usage: truthy(usage) ? usage : {} };
}

function batchTracking(connection: Connection, docId: number, schemaName: string): JsonObject | undefined {
	const rows = connection.all(
		"SELECT s.submission_id, s.provider, s.model, s.part, s.intent_at, s.batch_id, s.status, s.request_count, s.finalized_at FROM submissions AS s WHERE s.submission_id IN (SELECT submission_id FROM submission_requests WHERE doc_id = ?) ORDER BY s.intent_at, s.part, s.submission_id",
		docId,
	);
	if (rows.length === 0) return undefined;
	const finalized = rows
		.filter((row) => row.status === "finalized" && row.finalized_at)
		.map((row) => String(row.finalized_at));
	return {
		provider: [...new Set(rows.map((row) => String(row.provider)))].sort().join(","),
		batch_ids: [...new Set(rows.filter((row) => row.batch_id).map((row) => String(row.batch_id)))].sort(),
		parts: rows.length,
		fully_completed: rows.every((row) => row.status === "finalized"),
		processed_at: finalized.length > 0 ? finalized.sort()[finalized.length - 1] : null,
		completed_batches: rows.filter((row) => row.status === "finalized").length,
		failed_batches: rows.filter((row) => row.status === "failed").length,
		ordered_by_custom_id: true,
		missing_batches: rows
			.filter((row) => row.status === "unresolved")
			.map((row) => String(row.batch_id || row.submission_id))
			.sort(),
		recovered_batch_ids: [],
		tracking: rows.map((row) => ({
			batch_id: row.batch_id ?? null,
			metadata: { model: row.model, request_count: row.request_count, submission_id: row.submission_id },
			provider: row.provider,
			request_count: row.request_count,
			schema_name: schemaName,
			status: row.status,
			timestamp: row.intent_at,
		})),
	};
}

/** `render_output_json`. */
export function renderOutputJson(connection: Connection, docId: number): string {
	const doc = connection.get("SELECT name, kind FROM documents WHERE doc_id = ?", docId);
	if (!doc) throw new Error(`No document ${docId}`);
	const name = String(doc.name);
	const kind = doc.kind === null || doc.kind === undefined ? null : String(doc.kind);
	const stored = documentMetadata(connection, docId).metadata;
	const records: JsonObject[] = [];
	const failed: number[] = [];
	let total = 0;
	let complete = true;
	let latestModel: string | undefined;
	let timestamp: string | undefined;
	const rows = connection.all(
		"SELECT idx, status, source_index, content, model, provider, usage, provenance, stale, updated_at FROM units WHERE doc_id = ? AND kind = ? ORDER BY idx",
		docId,
		"chunk",
	);
	for (const row of rows) {
		const idx = Number(row.idx);
		const usage = loads(row.usage);
		const parsed = loads(row.provenance);
		const provenance: JsonObject = truthy(parsed) && isObject(parsed) ? parsed : {};
		total++;
		const updated = row.updated_at === null ? undefined : String(row.updated_at);
		if (updated && (timestamp === undefined || updated > timestamp)) timestamp = updated;
		if (row.status === "failed") failed.push(idx + 1);
		if (row.status !== "done" || Number(row.stale) || row.content === null) {
			complete = false;
			continue;
		}
		latestModel = String(row.model);
		const chunkIndex = idx + 1;
		const customId = provenance.custom_id;
		const record: JsonObject = {
			custom_id: truthy(customId) ? customId : defaultCustomId(name, kind, chunkIndex),
			chunk_index: chunkIndex,
			chunk_range: chunkRange(provenance, row.source_index),
			response: response(String(row.content), provenance, usage, String(row.model), String(row.provider)),
		};
		if (truthy(provenance.image_provenance)) record.image_provenance = provenance.image_provenance;
		records.push(record);
	}
	const entrySchemaName = connection.get(
		"SELECT schema_name FROM entry_rows WHERE doc_id = ? AND schema_name IS NOT NULL LIMIT 1",
		docId,
	)?.schema_name;
	const schemaName = truthy(stored.schema_name)
		? stored.schema_name
		: entrySchemaName !== undefined && entrySchemaName !== null
			? String(entrySchemaName)
			: "unknown";
	const meta: JsonObject = {
		schema_name: schemaName,
		model_name: truthy(stored.model_name) ? stored.model_name : (latestModel ?? "unknown"),
		chunking_method: truthy(stored.chunking_method) ? stored.chunking_method : "unknown",
		total_chunks: total,
		timestamp: truthy(stored.timestamp) ? stored.timestamp : (timestamp ?? null),
		version: 1,
	};
	for (const key of OPTIONAL) if (stored[key] !== undefined && stored[key] !== null) meta[key] = stored[key];
	if (!complete) meta.partial = true;
	if (failed.length > 0) meta.failed_chunks = failed;
	if (truthy(stored.image_provenance)) meta.image_provenance = stored.image_provenance;
	const tracking = truthy(stored.batch_tracking)
		? stored.batch_tracking
		: batchTracking(connection, docId, String(schemaName));
	if (truthy(tracking)) meta.batch_tracking = tracking;
	const known = new Set([...COMPUTED, ...LEADING, ...OPTIONAL, "timestamp", "image_provenance"]);
	for (const [key, value] of Object.entries(stored)) {
		if (!known.has(key) && key !== "batch_tracking") meta[key] = value;
	}
	return `${pyJsonDumps({ [METADATA_KEY]: meta, records }, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Schema helpers (output/entries.py)

/** `schema_types`: the JSON types a property schema allows, without null. */
export function schemaTypes(spec: JsonObject): string[] {
	const found: string[] = [];
	const declared = spec.type;
	if (typeof declared === "string") found.push(declared);
	else if (Array.isArray(declared)) found.push(...declared.map(String));
	for (const key of ["anyOf", "oneOf"]) {
		const options = spec[key];
		if (Array.isArray(options))
			for (const option of options) if (isObject(option)) found.push(...schemaTypes(option));
	}
	if ("properties" in spec && !found.includes("object")) found.push("object");
	return [...new Set(found.filter((item) => item !== "null"))];
}

/** `object_schema`: the object schema of `spec` or of one of its alternatives. */
export function objectSchema(spec: JsonObject): JsonObject | undefined {
	if (isObject(spec.properties)) return spec;
	for (const key of ["anyOf", "oneOf"]) {
		const options = spec[key];
		if (!Array.isArray(options)) continue;
		for (const option of options) {
			if (!isObject(option)) continue;
			const found = objectSchema(option);
			if (found) return found;
		}
	}
	return undefined;
}

/** `entry_schema`: the entry object of a schema file's JSON (or of a bare schema). */
export function entrySchema(schema: Json): JsonObject | undefined {
	if (!isObject(schema) || !truthy(schema)) return undefined;
	const body = isObject(schema.schema) ? schema.schema : schema;
	const root = objectSchema(body);
	if (!root) return undefined;
	const entries = (root.properties as JsonObject).entries;
	if (isObject(entries) && isObject(entries.items)) return objectSchema(entries.items);
	return root;
}

const SQL_TYPES: Record<string, string> = {
	string: "TEXT",
	integer: "INTEGER",
	number: "REAL",
	boolean: "INTEGER",
	object: "TEXT",
	array: "TEXT",
};

interface EntryField {
	name: string;
	sqlType: string;
}

function entryFields(schema: Json): EntryField[] {
	const spec = entrySchema(schema);
	if (!spec) return [];
	return Object.entries(spec.properties as JsonObject).map(([name, prop]) => {
		const types = isObject(prop) ? schemaTypes(prop) : [];
		return { name, sqlType: types.length === 1 ? (SQL_TYPES[types[0]] ?? "") : "" };
	});
}

function cellValue(value: Json): Param {
	if (typeof value === "boolean") return value ? 1 : 0;
	// Python's sqlite3 binds a float as REAL and an int as INTEGER.
	if (value instanceof PyNumberLexeme) return value.isFloat ? new Real(value.value) : BigInt(value.text);
	if (Array.isArray(value) || isObject(value)) return pyJsonDumps(value);
	if (value === undefined) return null;
	if (value === null || typeof value === "number" || typeof value === "string") return value;
	return String(value);
}

/**
 * `entries_writer`: replace the entries of chunk `idx`. The fields come from the schema's entry object (else from
 * the entries' own keys); missing `f_` columns are added and the `entries` view is created again.
 */
export function writeEntries(
	connection: Connection,
	docId: number,
	idx: number,
	entries: JsonObject[],
	options: { schema: Json; schemaName: string | null; runId: string; model: string; provider: string },
): void {
	connection.run("DELETE FROM entry_rows WHERE doc_id = ? AND kind = ? AND idx = ?", docId, "chunk", idx);
	if (entries.length === 0) return;
	let fields = entryFields(options.schema);
	if (fields.length === 0) {
		const names = [...new Set(entries.flatMap((entry) => Object.keys(entry)))];
		fields = names.map((name) => ({ name, sqlType: "" }));
	}
	const existing = new Map(
		connection.all("PRAGMA table_info(entry_rows)").map((row) => [pyCasefold(String(row.name)), String(row.name)]),
	);
	const columns = new Map<string, string>();
	let added = false;
	for (const field of fields) {
		const column = `f_${field.name}`;
		const key = pyCasefold(column);
		if (!existing.has(key)) {
			connection.exec(
				`ALTER TABLE entry_rows ADD COLUMN "${column.replace(/"/g, '""')}"${field.sqlType ? ` ${field.sqlType}` : ""}`,
			);
			existing.set(key, column);
			added = true;
		}
		columns.set(field.name, existing.get(key) as string);
	}
	if (added) createEntriesView(connection);
	const pairs = new Map<string, string>();
	for (const field of fields) {
		const key = pyCasefold(columns.get(field.name) as string);
		if (!pairs.has(key)) pairs.set(key, field.name);
	}
	const names = [...pairs.values()];
	const extra = names.map((field) => `, "${(columns.get(field) as string).replace(/"/g, '""')}"`).join("");
	const marks = Array.from({ length: 10 + names.length }, () => "?").join(", ");
	const sql = `INSERT INTO entry_rows (doc_id, kind, idx, entry_index, schema_name, run_id, tool, model, provider, entry${extra}) VALUES (${marks})`;
	entries.forEach((entry, position) => {
		connection.run(
			sql,
			docId,
			"chunk",
			idx,
			position,
			options.schemaName,
			options.runId,
			"mabillon",
			options.model,
			options.provider,
			pyJsonDumps(entry),
			...names.map((field) => cellValue(entry[field])),
		);
	});
}

// ---------------------------------------------------------------------------------------------------------------
// CSV view (output/csv_view.py)

type ColumnPath = string[];

function schemaPaths(spec: JsonObject, prefix: ColumnPath = []): ColumnPath[] {
	const paths: ColumnPath[] = [];
	for (const [name, prop] of Object.entries(spec.properties as JsonObject)) {
		const path = [...prefix, name];
		const nested = isObject(prop) ? objectSchema(prop) : undefined;
		const types = isObject(prop) ? schemaTypes(prop) : [];
		if (nested && types.length === 1 && types[0] === "object") paths.push(...schemaPaths(nested, path));
		else paths.push(path);
	}
	return paths;
}

function valuePaths(value: JsonObject, prefix: ColumnPath = []): ColumnPath[] {
	const paths: ColumnPath[] = [];
	for (const [key, item] of Object.entries(value)) {
		const path = [...prefix, key];
		if (isObject(item) && truthy(item)) paths.push(...valuePaths(item, path));
		else paths.push(path);
	}
	return paths;
}

function csvColumns(schema: Json, entries: JsonObject[]): ColumnPath[] {
	const spec = entrySchema(schema);
	if (spec) return schemaPaths(spec);
	const seen = new Map<string, ColumnPath>();
	for (const entry of entries) {
		for (const path of valuePaths(entry)) {
			const key = JSON.stringify(path);
			if (!seen.has(key)) seen.set(key, path);
		}
	}
	return [...seen.values()];
}

function scalar(value: Json): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "string") return value;
	if (typeof value === "number") return pyNumber(value);
	if (value instanceof PyNumberLexeme) return value.text;
	return pyJsonDumps(value);
}

function cell(value: Json): string {
	if (Array.isArray(value)) {
		if (value.every((item) => !Array.isArray(item) && !isObject(item))) return value.map(scalar).join("; ");
		return pyJsonDumps(value);
	}
	return scalar(value);
}

function lookup(entry: JsonObject, path: ColumnPath): Json {
	let value: Json = entry;
	for (const key of path) {
		if (!isObject(value)) return null;
		value = key in value ? value[key] : null;
	}
	return value;
}

/** One CSV row as Python's `csv.writer` (excel dialect, minimal quoting) writes it, with "\n" line ends. */
function csvRow(fields: string[]): string {
	if (fields.length === 1 && fields[0] === "") return '""\n';
	return `${fields.map((field) => (/[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field)).join(",")}\n`;
}

/** The CSV of `entries`, its columns from the schema file's entry object (else from the entries' own keys). */
export function renderEntriesCsv(schema: Json, entries: JsonObject[]): string {
	const columns = csvColumns(schema, entries);
	let out = csvRow(columns.map((path) => path.join(".")));
	for (const entry of entries) out += csvRow(columns.map((path) => cell(lookup(entry, path))));
	return `﻿${out}`;
}

/** `render_csv`. */
export function renderCsv(connection: Connection, docId: number): string {
	const entries: JsonObject[] = [];
	for (const row of connection.all(
		"SELECT e.entry FROM entry_rows AS e JOIN units AS u ON u.doc_id = e.doc_id AND u.kind = e.kind AND u.idx = e.idx WHERE e.doc_id = ? AND e.kind = ? AND u.status = 'done' AND u.stale = 0 AND u.run_id = e.run_id ORDER BY e.idx, e.entry_index",
		docId,
		"chunk",
	)) {
		const value = pyJsonParse(String(row.entry)) as Json;
		if (isObject(value)) entries.push(value);
	}
	let schema: Json;
	const sha = documentMetadata(connection, docId).schemaSha256;
	if (sha !== undefined) {
		const text = connection.get("SELECT text FROM artifacts WHERE sha256 = ?", sha)?.text;
		const parsed = text === undefined ? undefined : loads(text);
		schema = isObject(parsed) ? parsed : undefined;
	}
	return renderEntriesCsv(schema, entries);
}
