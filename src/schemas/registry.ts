import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Mode } from "../config.ts";
import { getPackageRoot, naturalCompare, sha256 } from "../util.ts";
import { compileSchema } from "../verify/validate.ts";

export type JsonSchema = Record<string, unknown>;

export interface SchemaRules {
	/** Force the schema's mode when the automatic detection (a "transcription" property) is wrong. */
	kind?: SchemaKind;
	/** Transcription schemas: the string field that receives the Markdown body of a unit file. */
	bodyField?: string;
	/**
	 * Extraction: entries crossing a unit boundary are recorded complete in the unit where they begin ("complete",
	 * the default), or as page-local parts flagged as fragments ("fragments").
	 */
	boundary?: BoundaryPolicy;
	/** Extraction schemas: entry fields that must copy the source verbatim (checked against text sources). */
	verbatimFields?: string[];
}

export type SchemaKind = "transcription" | "extraction";
export type BoundaryPolicy = "complete" | "fragments";

export interface LoadedSchema {
	name: string;
	path: string;
	/** The inner JSON Schema (the "schema" member of a {name, strict, schema} wrapper, or the whole file). */
	schema: JsonSchema;
	sha256: string;
	/** Digest of earlier versions (sha256 of the schema text alone); accepted when a run resumes, then upgraded. */
	legacySha256: string;
	rules: SchemaRules;
	kind: SchemaKind;
	bundled: boolean;
}

export const DEFAULT_TRANSCRIPTION_SCHEMA = "diplomatic_markdown_transcription";

export function bundledSchemaDirs(): string[] {
	const root = getPackageRoot();
	return [join(root, "schemas", "transcription"), join(root, "schemas", "extraction")];
}

function bundledRulesDir(): string {
	return join(getPackageRoot(), "schemas", "rules");
}

/** The first existing rules file among `candidates`, parsed, with its raw text (empty when there is none). */
function readRules(candidates: string[]): { rules: SchemaRules; text: string } {
	for (const path of candidates) {
		if (existsSync(path)) {
			let rules: SchemaRules;
			const text = readFileSync(path, "utf8");
			try {
				rules = JSON.parse(text) as SchemaRules;
			} catch (error) {
				throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
			}
			if (rules.verbatimFields && !Array.isArray(rules.verbatimFields)) {
				throw new Error(`${path}: verbatimFields must be an array of field paths`);
			}
			if (rules.kind && rules.kind !== "transcription" && rules.kind !== "extraction") {
				throw new Error(`${path}: kind must be "transcription" or "extraction"`);
			}
			if (rules.boundary !== undefined && rules.boundary !== "complete" && rules.boundary !== "fragments") {
				throw new Error(`${path}: boundary must be "complete" or "fragments"`);
			}
			return { rules, text };
		}
	}
	return { rules: {}, text: "" };
}

/**
 * Fingerprint of a schema: its text with line endings normalized (CRLF and LF copies match) plus the text of its
 * rules file, so edits to either are detected when a run resumes.
 */
function schemaHash(schemaText: string, rulesText: string): string {
	const lf = (text: string) => text.replace(/\r\n?/g, "\n");
	return sha256(rulesText === "" ? lf(schemaText) : `${lf(schemaText)}\u0000rules\u0000${lf(rulesText)}`);
}

function properties(schema: JsonSchema): Record<string, JsonSchema> {
	const props = schema.properties;
	return props && typeof props === "object" ? (props as Record<string, JsonSchema>) : {};
}

/** Load a schema file in the {name, strict, schema} wrapper format, or a bare JSON Schema. */
export function loadSchemaFile(path: string, bundled = false): LoadedSchema {
	const absolute = resolve(path);
	const raw = readFileSync(absolute, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`${absolute}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${absolute}: expected a JSON object`);
	}
	const object = parsed as Record<string, unknown>;
	const isWrapper = typeof object.schema === "object" && object.schema !== null && !Array.isArray(object.schema);
	const schema = (isWrapper ? object.schema : object) as JsonSchema;
	const stem = basename(absolute, extname(absolute));
	const name = isWrapper && typeof object.name === "string" ? object.name : stem;
	const dir = dirname(absolute);
	const { rules, text: rulesText } = readRules([
		join(dir, "rules", `${name}.rules.json`),
		join(dir, "rules", `${stem}.rules.json`),
		join(bundledRulesDir(), `${name}.rules.json`),
	]);
	const hash = schemaHash(raw, rulesText);
	const props = properties(schema);
	const bodyField = rules.bodyField ?? ("transcription" in props ? "transcription" : undefined);
	const kind: SchemaKind = rules.kind ?? (bodyField && bodyField in props ? "transcription" : "extraction");
	if (kind === "transcription") {
		if (!bodyField || !(bodyField in props)) {
			throw new Error(
				`${absolute}: a transcription schema needs a string body field (set "bodyField" in its rules file)`,
			);
		}
		rules.bodyField = bodyField;
	}
	try {
		compileSchema(schema, `${name}:${hash}`);
	} catch (error) {
		throw new Error(`${absolute}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { name, path: absolute, schema, sha256: hash, legacySha256: sha256(raw), rules, kind, bundled };
}

function schemaFilesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.toLowerCase().endsWith(".json") && !name.toLowerCase().endsWith(".rules.json"))
		.sort(naturalCompare)
		.map((name) => join(dir, name));
}

export interface SchemaLoadError {
	path: string;
	error: string;
	/** The schema's declared name, if the file is at least readable JSON with a wrapper name. */
	name?: string;
	bundled?: boolean;
}

function declaredName(path: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
		return typeof parsed?.name === "string" ? parsed.name : undefined;
	} catch {
		return undefined;
	}
}

/** Schema files that could not be loaded during the last listSchemas() call. */
export const schemaLoadErrors: SchemaLoadError[] = [];

/** All schemas: user directories first (they shadow bundled schemas with the same name), then bundled. */
export function listSchemas(extraDirs: string[]): LoadedSchema[] {
	const result: LoadedSchema[] = [];
	const names = new Set<string>();
	schemaLoadErrors.length = 0;
	const sources: Array<{ dir: string; bundled: boolean }> = [
		...extraDirs.map((dir) => ({ dir, bundled: false })),
		...bundledSchemaDirs().map((dir) => ({ dir, bundled: true })),
	];
	for (const { dir, bundled } of sources) {
		for (const path of schemaFilesIn(dir)) {
			let loaded: LoadedSchema;
			try {
				loaded = loadSchemaFile(path, bundled);
			} catch (error) {
				schemaLoadErrors.push({
					path,
					error: error instanceof Error ? error.message : String(error),
					name: declaredName(path),
					bundled,
				});
				continue;
			}
			const key = loaded.name.toLowerCase();
			if (names.has(key)) continue;
			names.add(key);
			result.push(loaded);
		}
	}
	return result;
}

/** Resolve --schema (a path, a schema name, or a file stem); transcription defaults to the bundled schema. */
export function resolveSchema(spec: string | undefined, mode: Mode, extraDirs: string[]): LoadedSchema {
	const wanted = spec ?? (mode === "transcribe" ? DEFAULT_TRANSCRIPTION_SCHEMA : undefined);
	if (!wanted) {
		throw new Error("Extraction needs a schema: pass --schema <name|path> (see `mabillon schemas`).");
	}
	let loaded: LoadedSchema | undefined;
	if (existsSync(wanted) || wanted.endsWith(".json")) {
		if (!existsSync(wanted)) throw new Error(`Schema file not found: ${wanted}`);
		loaded = loadSchemaFile(wanted);
	} else {
		const lower = wanted.toLowerCase();
		const all = listSchemas(extraDirs);
		// A user schema of that name (or file stem) that fails to load must not be replaced silently by a bundled one.
		const broken = schemaLoadErrors.find(
			(problem) =>
				!problem.bundled &&
				(problem.name?.toLowerCase() === lower || basename(problem.path, ".json").toLowerCase() === lower),
		);
		loaded =
			all.find((schema) => schema.name.toLowerCase() === lower) ??
			all.find((schema) => basename(schema.path, ".json").toLowerCase() === lower);
		if (broken && (!loaded || loaded.bundled)) {
			throw new Error(`Schema "${wanted}" could not be loaded: ${broken.error}`);
		}
		if (!loaded) {
			const problems = schemaLoadErrors.map((problem) => `\n  could not load ${problem.error}`).join("");
			throw new Error(
				`Unknown schema "${wanted}". Available: ${all.map((schema) => schema.name).join(", ")}${problems}`,
			);
		}
	}
	if (mode === "transcribe" && loaded.kind !== "transcription") {
		throw new Error(
			`Schema "${loaded.name}" is not a transcription schema (it needs a string body field such as "transcription", or a rules file with "bodyField").`,
		);
	}
	if (mode === "extract" && loaded.kind !== "extraction") {
		throw new Error(`Schema "${loaded.name}" is a transcription schema; use it with \`mabillon transcribe\`.`);
	}
	return loaded;
}

/** Follow a local "#/..." JSON pointer $ref within the schema. */
export function resolveRef(root: JsonSchema, node: JsonSchema | undefined): JsonSchema | undefined {
	let current = node;
	for (let depth = 0; current && typeof current.$ref === "string" && depth < 10; depth++) {
		const ref = current.$ref as string;
		if (!ref.startsWith("#/")) return current;
		let target: unknown = root;
		for (const part of ref.slice(2).split("/")) {
			const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
			target = target && typeof target === "object" ? (target as Record<string, unknown>)[key] : undefined;
		}
		current = target as JsonSchema | undefined;
	}
	return current;
}

/** Whether a (possibly $ref'd, nullable, or anyOf/oneOf) schema admits the given JSON type. */
function admitsType(root: JsonSchema, node: JsonSchema | undefined, type: string): boolean {
	const resolved = resolveRef(root, node);
	if (!resolved) return false;
	const declared = resolved.type;
	if (declared === type || (Array.isArray(declared) && declared.includes(type))) return true;
	const options = (resolved.anyOf ?? resolved.oneOf) as JsonSchema[] | undefined;
	return Array.isArray(options) && options.some((option) => admitsType(root, option, type));
}

/** Envelope shape shared by ChronoMiner-style schemas: {contains_no_content_of_requested_type, entries}. */
export interface EnvelopeInfo {
	entriesField?: string;
	emptyFlag?: string;
	otherFields: string[];
}

export function envelopeInfo(schema: JsonSchema): EnvelopeInfo {
	const props = properties(schema);
	const entriesField = "entries" in props && admitsType(schema, props.entries, "array") ? "entries" : undefined;
	const emptyFlag =
		"contains_no_content_of_requested_type" in props &&
		admitsType(schema, props.contains_no_content_of_requested_type, "boolean")
			? "contains_no_content_of_requested_type"
			: undefined;
	const otherFields = Object.keys(props).filter((key) => key !== entriesField && key !== emptyFlag);
	return { entriesField, emptyFlag, otherFields };
}

function escapePointer(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * The array branch of a (possibly $ref'd, nullable, anyOf/oneOf) property, with the JSON pointer to it within the
 * root (following local $refs).
 */
function arrayBranch(
	root: JsonSchema,
	node: JsonSchema | undefined,
	pointer: string,
	depth = 0,
): { schema: JsonSchema; pointer: string } | undefined {
	if (!node || depth > 10) return undefined;
	if (typeof node.$ref === "string") {
		if (!node.$ref.startsWith("#/")) return undefined;
		// One hop at a time, so the pointer names the schema actually reached (chains such as alias -> list).
		let target: unknown = root;
		for (const part of node.$ref.slice(2).split("/")) {
			const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
			target = target && typeof target === "object" ? (target as Record<string, unknown>)[key] : undefined;
		}
		return arrayBranch(root, target as JsonSchema | undefined, node.$ref.slice(1), depth + 1);
	}
	const declared = node.type;
	if (declared === "array" || (Array.isArray(declared) && declared.includes("array")))
		return { schema: node, pointer };
	for (const key of ["anyOf", "oneOf"]) {
		const options = node[key] as JsonSchema[] | undefined;
		if (!Array.isArray(options)) continue;
		for (let i = 0; i < options.length; i++) {
			const found = arrayBranch(root, options[i], `${pointer}/${key}/${i}`, depth + 1);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * The item schema of the envelope's entries array, as written in the schema (its $refs still point into the root),
 * and its JSON pointer within the root. Undefined when there is no entries array with a single item schema.
 */
export function entryItemSchema(schema: JsonSchema): { schema: JsonSchema; pointer: string } | undefined {
	const info = envelopeInfo(schema);
	if (!info.entriesField) return undefined;
	const branch = arrayBranch(
		schema,
		properties(schema)[info.entriesField],
		`/properties/${escapePointer(info.entriesField)}`,
	);
	const items = branch?.schema.items;
	if (!branch || !items || typeof items !== "object" || Array.isArray(items)) return undefined;
	return { schema: items as JsonSchema, pointer: `${branch.pointer}/items` };
}

/**
 * How entries crossing a unit boundary are recorded: the rules file's `boundary`, else "fragments" when the entries
 * have a boolean property whose name contains "fragment" (e.g. entry_is_fragment), else "complete".
 */
export function boundaryPolicy(schema: LoadedSchema): BoundaryPolicy {
	if (schema.rules.boundary) return schema.rules.boundary;
	const items = entryItemSchema(schema.schema);
	const props = (resolveRef(schema.schema, items?.schema)?.properties ?? {}) as Record<string, JsonSchema>;
	const fragmentFlag = Object.entries(props).some(
		([name, prop]) => /fragment/i.test(name) && admitsType(schema.schema, prop, "boolean"),
	);
	return fragmentFlag ? "fragments" : "complete";
}

/**
 * A validation schema for a part of `root` (given by JSON pointers): the whole root is embedded as its own resource,
 * so every local $ref in it (#/$defs/..., #/properties/...) resolves against the root as written.
 */
export function rootPartSchema(root: JsonSchema, part: JsonSchema): JsonSchema {
	const { $schema: _schema, ...rest } = root;
	const id = typeof root.$id === "string" ? root.$id : "urn:mabillon:schema-root";
	const refer = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(refer);
		if (!node || typeof node !== "object") return node;
		const object = node as JsonSchema;
		if (typeof object.$rootPointer === "string") return { $ref: `${id}#${object.$rootPointer}` };
		return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, refer(value)]));
	};
	return { ...(refer(part) as JsonSchema), $defs: { mabillonRoot: { ...rest, $id: id } } };
}

/** JSON pointer to a top-level property of the root. */
export function propertyPointer(key: string): string {
	return `/properties/${escapePointer(key)}`;
}

const DOCUMENTATION_KEYS = new Set(["description", "$comment", "examples", "title", "default", "$schema", "$id"]);

/**
 * A copy of a sub-schema for a tool's parameter declaration: local $refs inlined, documentation keywords dropped
 * (the field descriptions are in the system prompt already). Undefined for recursive or unresolvable $refs.
 */
export function inlineSchema(root: JsonSchema, node: unknown, stack: string[] = []): unknown {
	if (Array.isArray(node)) {
		const items = node.map((item) => inlineSchema(root, item, stack));
		return items.includes(undefined) ? undefined : items;
	}
	if (!node || typeof node !== "object") return node;
	const object = node as JsonSchema;
	if (typeof object.$ref === "string") {
		const ref = object.$ref;
		if (!ref.startsWith("#/") || stack.includes(ref) || stack.length > 20) return undefined;
		const target = resolveRef(root, { $ref: ref });
		if (!target || typeof target.$ref === "string") return undefined;
		const { $ref: _ref, ...siblings } = object;
		const inlined = inlineSchema(root, { ...target, ...siblings }, [...stack, ref]);
		return inlined;
	}
	const out: JsonSchema = {};
	for (const [key, value] of Object.entries(object)) {
		if (DOCUMENTATION_KEYS.has(key) || key === "$defs" || key === "definitions") continue;
		// Inside "properties" every key is a field name, not a keyword.
		if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
			const props: JsonSchema = {};
			for (const [name, sub] of Object.entries(value as JsonSchema)) {
				const inlined = inlineSchema(root, sub, stack);
				if (inlined === undefined) return undefined;
				props[name] = inlined;
			}
			out[key] = props;
			continue;
		}
		const inlined = inlineSchema(root, value, stack);
		if (inlined === undefined) return undefined;
		out[key] = inlined;
	}
	return out;
}

/** Whether a schema property admits null. */
export function isNullable(schema: JsonSchema, field: string): boolean {
	const prop = properties(schema)[field];
	return prop ? admitsType(schema, prop, "null") : false;
}
