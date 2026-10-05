import { parseDocument } from "yaml";
import { envelopeInfo, isNullable, type JsonSchema, type LoadedSchema, resolveRef } from "../schemas/registry.ts";
import type { Issue } from "./issues.ts";

/** Split a transcription unit file ("---\nfront matter\n---\nbody") and assemble the schema object. */
export function parseTranscriptionUnit(
	text: string,
	schema: LoadedSchema,
): { data?: Record<string, unknown>; body?: string; issues: Issue[] } {
	const bodyField = schema.rules.bodyField ?? "transcription";
	const normalized = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
	// Front matter may be empty ("---\n---").
	const match = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(normalized);
	if (!match) {
		return {
			// The whole text stands in as the body, so a page closed for review keeps its transcription in the outputs.
			body: normalized.replace(/\s+$/, ""),
			issues: [
				{
					severity: "error",
					layer: "parse",
					message:
						'The file must start with a YAML front matter block between "---" lines (the non-body fields), followed by the transcription body.',
				},
			],
		};
	}
	const body = normalized.slice(match[0].length).replace(/^\n/, "").replace(/\s+$/, "");
	const doc = parseDocument(match[1] ?? "", { prettyErrors: true });
	if (doc.errors.length > 0) {
		return {
			body,
			issues: doc.errors.map((error) => ({
				severity: "error" as const,
				layer: "parse" as const,
				message: `Front matter YAML: ${error.message.split("\n")[0]} (use "key: |" block scalars for free text)`,
			})),
		};
	}
	const front = doc.toJS() as unknown;
	if (front !== null && (typeof front !== "object" || Array.isArray(front))) {
		return {
			issues: [{ severity: "error", layer: "parse", message: "Front matter must be a mapping of field: value" }],
		};
	}
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries((front ?? {}) as Record<string, unknown>)) {
		// Block scalars ("key: |") end with a newline that is not part of the value.
		fields[key] = typeof value === "string" ? value.replace(/\n+$/, "") : value;
	}
	const issues: Issue[] = [];
	if (bodyField in fields) {
		issues.push({
			severity: "error",
			layer: "parse",
			message: `Put the ${bodyField} text in the body below the front matter, not in a "${bodyField}" key.`,
		});
		delete fields[bodyField];
	}
	const data: Record<string, unknown> = { ...fields };
	data[bodyField] = body === "" ? (isNullable(schema.schema, bodyField) ? null : "") : body;
	return { data, body, issues };
}

/** Offset of the first JSON syntax error (a small recursive-descent scan), or undefined if none is found. */
export function jsonErrorOffset(text: string): number | undefined {
	let i = 0;
	const ws = () => {
		while (i < text.length && " \t\n\r".includes(text[i])) i++;
	};
	const fail = (): never => {
		throw i;
	};
	const literal = (word: string) => {
		if (text.startsWith(word, i)) i += word.length;
		else fail();
	};
	const string = () => {
		i++;
		while (i < text.length && text[i] !== '"') {
			if (text[i] === "\\") i++;
			else if (text.charCodeAt(i) < 0x20) fail();
			i++;
		}
		if (text[i] !== '"') fail();
		i++;
	};
	const number = () => {
		const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
		if (!match) fail();
		i += match![0].length;
	};
	const value = (): void => {
		ws();
		const c = text[i];
		if (c === "{") {
			i++;
			ws();
			if (text[i] === "}") {
				i++;
				return;
			}
			for (;;) {
				ws();
				if (text[i] !== '"') fail();
				string();
				ws();
				if (text[i] !== ":") fail();
				i++;
				value();
				ws();
				if (text[i] === ",") i++;
				else if (text[i] === "}") {
					i++;
					return;
				} else fail();
			}
		} else if (c === "[") {
			i++;
			ws();
			if (text[i] === "]") {
				i++;
				return;
			}
			for (;;) {
				value();
				ws();
				if (text[i] === ",") i++;
				else if (text[i] === "]") {
					i++;
					return;
				} else fail();
			}
		} else if (c === '"') string();
		else if (c === "t") literal("true");
		else if (c === "f") literal("false");
		else if (c === "n") literal("null");
		else if (c === "-" || (c >= "0" && c <= "9")) number();
		else fail();
	};
	try {
		value();
		ws();
		return i < text.length ? i : undefined;
	} catch (offset) {
		return typeof offset === "number" ? offset : undefined;
	}
}

/** Parse an extraction unit file (JSON) with a readable error location. */
export function parseJsonUnit(text: string): { data?: unknown; issues: Issue[] } {
	const clean = text.replace(/^﻿/, "");
	try {
		return { data: JSON.parse(clean), issues: [] };
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 160);
		const offset = jsonErrorOffset(clean);
		let location = "";
		if (offset !== undefined) {
			const before = clean.slice(0, offset);
			const line = before.split("\n").length;
			const column = offset - before.lastIndexOf("\n");
			const lineText = clean.split("\n")[line - 1] ?? "";
			location = ` at line ${line}, column ${column} (near ${JSON.stringify(lineText.trim().slice(0, 60))})`;
		}
		return { issues: [{ severity: "error", layer: "parse", message: `Invalid JSON${location}: ${message}` }] };
	}
}

/** Tool-call leakage: never legitimate content. */
const LEAK_PATTERN = /\$PARAMETER_NAME|<\/?(?:invoke|parameter|function_calls)\b/;
/** Schema or field names inside values: usually leakage, occasionally legitimate (e.g. JSON sources). */
const BLEED_PATTERN =
	/"additionalProperties"|"\$schema"|"type"\s*:\s*"object"|\bcontains_no_content_of_requested_type\b|\btranscription_not_possible\b|\bno_transcribable_text\b/;

function walkStrings(value: unknown, pointer: string, visit: (text: string, pointer: string) => void): void {
	if (typeof value === "string") {
		visit(value, pointer || "/");
	} else if (Array.isArray(value)) {
		value.forEach((item, index) => {
			walkStrings(item, `${pointer}/${index}`, visit);
		});
	} else if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) walkStrings(item, `${pointer}/${key}`, visit);
	}
}

/** Detect generation loops: the tail of the text repeating one period four or more times. */
export function hasTailLoop(text: string): boolean {
	const tail = text.slice(-2400);
	for (let period = 8; period <= 400; period++) {
		if (tail.length < period * 4) break;
		const unit = tail.slice(tail.length - period);
		if (unit.trim().length < 4) continue;
		let repeats = 1;
		while (repeats < 4 && tail.slice(tail.length - period * (repeats + 1), tail.length - period * repeats) === unit) {
			repeats++;
		}
		if (repeats >= 4) return true;
	}
	return false;
}

function repeatedLineRun(text: string): string | undefined {
	const lines = text.split("\n");
	let run = 1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.length >= 10 && line === lines[i - 1].trim()) {
			run++;
			if (run >= 5) return line;
		} else {
			run = 1;
		}
	}
	return undefined;
}

export function qualityIssues(data: unknown): Issue[] {
	const issues: Issue[] = [];
	walkStrings(data, "", (text, pointer) => {
		if (LEAK_PATTERN.test(text)) {
			issues.push({
				severity: "error",
				layer: "quality",
				pointer,
				message: "contains tool-call markup; the value must contain only source content",
			});
		} else if (BLEED_PATTERN.test(text)) {
			issues.push({
				severity: "warning",
				layer: "quality",
				pointer,
				message: "contains schema or field names; make sure the value holds only source content",
			});
		}
		if (text.length > 200 && hasTailLoop(text)) {
			issues.push({
				severity: "warning",
				layer: "quality",
				pointer,
				message: "the end of this text repeats the same passage several times (generation loop?)",
			});
		}
		const repeated = repeatedLineRun(text);
		if (repeated) {
			issues.push({
				severity: "warning",
				layer: "quality",
				pointer,
				message: `the line "${repeated.slice(0, 60)}" repeats 5+ times in a row; check against the source`,
			});
		}
	});
	return issues;
}

const ALLOWED_TAGS = ["page_number", "unclear", "gap", "br", "sup", "sub", "u", "s", "del", "ins"];
const TABLE_TAGS = ["table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption"];

const tagCache = new WeakMap<JsonSchema, Set<string>>();

/**
 * Tags a transcription body may contain: the common markers plus every tag the body field's description names
 * (e.g. `<running_head>`, `<stamp>`); a schema that names `<table>` allows the whole table element family.
 */
export function allowedTranscriptionTags(schema: LoadedSchema): Set<string> {
	const cached = tagCache.get(schema.schema);
	if (cached) return cached;
	const allowed = new Set(ALLOWED_TAGS);
	const props = (schema.schema.properties ?? {}) as Record<string, JsonSchema>;
	const field = resolveRef(schema.schema, props[schema.rules.bodyField ?? "transcription"]);
	const description = typeof field?.description === "string" ? field.description : "";
	for (const match of description.matchAll(/<\/?([A-Za-z][\w-]*)[^<>]*>/g)) allowed.add(match[1].toLowerCase());
	if (allowed.has("table")) for (const tag of TABLE_TAGS) allowed.add(tag);
	tagCache.set(schema.schema, allowed);
	return allowed;
}

/** Marker conventions of the transcription schemas; tags outside `allowedTags` are reported as unexpected. */
export function markerIssues(body: string, allowedTags: Set<string> = new Set(ALLOWED_TAGS)): Issue[] {
	const issues: Issue[] = [];
	const count = (pattern: RegExp) => (body.match(pattern) ?? []).length;
	const pageOpen = count(/<page_number>/g);
	const pageClose = count(/<\/page_number>/g);
	if (pageOpen !== pageClose) {
		issues.push({
			severity: "error",
			layer: "rules",
			message: `unbalanced <page_number> tags (${pageOpen} opening, ${pageClose} closing); format: <page_number>9</page_number>`,
		});
	}
	if (/<page_number>\s*<\/page_number>/.test(body)) {
		issues.push({ severity: "warning", layer: "rules", message: "empty <page_number></page_number> tag" });
	}
	const unclearOpen = count(/<unclear>/g);
	const unclearClose = count(/<\/unclear>/g);
	if (unclearOpen !== unclearClose) {
		issues.push({
			severity: "error",
			layer: "rules",
			message: `unbalanced <unclear> tags (${unclearOpen} opening, ${unclearClose} closing)`,
		});
	}
	if (/<gap\s*>|<\/gap>/.test(body)) {
		issues.push({ severity: "error", layer: "rules", message: "write illegible passages as a self-closing <gap/>" });
	}
	const uncertain = unclearOpen + count(/<gap\s*\/>/g);
	if (uncertain > 25) {
		issues.push({
			severity: "warning",
			layer: "rules",
			message: `${uncertain} uncertain passages marked; zoom into difficult regions before settling for <unclear>/<gap/>`,
		});
	}
	const references = new Set((body.match(/\[\^([^\]\s]+)\](?!:)/g) ?? []).map((ref) => ref.slice(2, -1)));
	const definitions = new Set((body.match(/\[\^([^\]\s]+)\]:/g) ?? []).map((def) => def.slice(2, -2)));
	for (const ref of references) {
		if (!definitions.has(ref)) {
			issues.push({
				severity: "warning",
				layer: "rules",
				message: `footnote reference [^${ref}] has no "[^${ref}]: ..." note on this page (fine if the note is printed elsewhere)`,
			});
		}
	}
	const unknown = new Set<string>();
	for (const tag of body.match(/<\/?([A-Za-z][\w-]*)[^>]*>/g) ?? []) {
		const name = /<\/?([A-Za-z][\w-]*)/.exec(tag)?.[1]?.toLowerCase();
		if (name && !allowedTags.has(name)) unknown.add(name);
	}
	if (unknown.size > 0) {
		issues.push({
			severity: "warning",
			layer: "rules",
			message: `unexpected tags: ${[...unknown].map((tag) => `<${tag}>`).join(", ")}; use markdown and the documented markers only`,
		});
	}
	return issues;
}

/** Rules for the transcription flags (no_transcribable_text / transcription_not_possible). */
export function transcriptionFlagIssues(data: Record<string, unknown>, bodyField: string): Issue[] {
	const issues: Issue[] = [];
	const body = data[bodyField];
	const hasBody = typeof body === "string" && body.trim() !== "";
	const flagged = data.no_transcribable_text === true || data.transcription_not_possible === true;
	if (flagged && hasBody) {
		issues.push({
			severity: "error",
			layer: "rules",
			message: `a page flagged no_transcribable_text or transcription_not_possible must have an empty body`,
		});
	}
	if (!flagged && !hasBody && ("no_transcribable_text" in data || "transcription_not_possible" in data)) {
		issues.push({
			severity: "error",
			layer: "rules",
			message: "the body is empty: transcribe the page, or set no_transcribable_text: true for a page without text",
		});
	}
	return issues;
}

/** Rules for ChronoMiner-style envelopes ({contains_no_content_of_requested_type, entries}). */
export function envelopeIssues(data: unknown, schema: JsonSchema): Issue[] {
	if (!data || typeof data !== "object" || Array.isArray(data)) return [];
	const info = envelopeInfo(schema);
	if (!info.entriesField || !info.emptyFlag) return [];
	const object = data as Record<string, unknown>;
	const entries = object[info.entriesField];
	const flag = object[info.emptyFlag];
	if (!Array.isArray(entries)) return [];
	const issues: Issue[] = [];
	if (flag === true && entries.length > 0) {
		issues.push({
			severity: "error",
			layer: "rules",
			pointer: `/${info.emptyFlag}`,
			message: `is true but ${entries.length} entries are present; set it to false or remove the entries`,
		});
	}
	if (flag === false && entries.length === 0) {
		issues.push({
			severity: "warning",
			layer: "rules",
			pointer: `/${info.emptyFlag}`,
			message: "is false but there are no entries; set it to true if this unit has no content of the requested type",
		});
	}
	for (const [index, entry] of entries.entries()) {
		walkStrings(entry, `/${info.entriesField}/${index}`, (text, pointer) => {
			if (/<page_number>/.test(text)) {
				issues.push({
					severity: "warning",
					layer: "rules",
					pointer,
					message: "contains a <page_number> marker; extracted values should not carry transcription markup",
				});
			}
		});
	}
	return issues;
}

/**
 * Normalize text for grounding: drop transcription markup (page markers, <unclear>, <gap/>, HTML comments, markdown
 * emphasis), NFKC (ſ to s, ligatures), join words hyphenated across a line break when the next line continues in
 * lower case, lower case, word tokens.
 */
export function groundingTokens(text: string): string[] {
	return (
		text
			.replace(/<!--[\s\S]*?-->/g, " ")
			.replace(/<page_number>[\s\S]*?<\/page_number>/g, " ")
			.replace(/<\/?[A-Za-z][\w-]*[^>]*>/g, "")
			.normalize("NFKC")
			.replace(/(\p{L})[-¬=⸗]\s*\n\s*(?=\p{Ll})/gu, "$1")
			.toLowerCase()
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

function trigrams(tokens: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i + 2 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
	return out;
}

export interface GroundingSource {
	tokens: Set<string>;
	trigrams: Set<string>;
	/** The source itself contains U+FFFD replacement characters. */
	hasReplacement?: boolean;
}

export function buildGroundingSource(text: string): GroundingSource {
	const tokens = groundingTokens(text);
	return { tokens: new Set(tokens), trigrams: new Set(trigrams(tokens)), hasReplacement: text.includes("�") };
}

/** Share of a value's word trigrams (or words, for very short values) found in the source. */
export function groundingCoverage(value: string, source: GroundingSource): number {
	const tokens = groundingTokens(value);
	if (tokens.length === 0) return 1;
	if (tokens.length < 3) return tokens.filter((token) => source.tokens.has(token)).length / tokens.length;
	const grams = trigrams(tokens);
	return grams.filter((gram) => source.trigrams.has(gram)).length / grams.length;
}

function valuesAtPath(value: unknown, path: string[], pointer: string): Array<{ value: unknown; pointer: string }> {
	if (path.length === 0) return [{ value, pointer }];
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => valuesAtPath(item, path, `${pointer}/${index}`));
	}
	if (value && typeof value === "object") {
		const [head, ...rest] = path;
		if (!(head in (value as Record<string, unknown>))) return [];
		return valuesAtPath((value as Record<string, unknown>)[head], rest, `${pointer}/${head}`);
	}
	return [];
}

/** Start of the coverage warning's message (the unit gate recognizes the warning by it). */
export const COVERAGE_WARNING = "entries' verbatim text covers only";

/** Chunks shorter than this (characters) are not checked for coverage. */
export const MIN_COVERAGE_CHUNK = 300;

/**
 * Warn when the entries' verbatim fields together cover too little of the unit's own chunk text (look-ahead
 * excluded): entries were probably left out. A chunk word counts as covered when a word trigram containing it
 * occurs in some verbatim value. Skipped for empty entries, short chunks, and schemas without verbatim fields.
 */
export function coverageIssues(data: unknown, schema: LoadedSchema, chunkText: string, threshold: number): Issue[] {
	if (chunkText.trim().length < MIN_COVERAGE_CHUNK) return [];
	const share = chunkCoverage(data, schema, chunkText);
	if (share === undefined || share >= threshold) return [];
	const info = envelopeInfo(schema.schema);
	return [
		{
			severity: "warning",
			layer: "grounding",
			pointer: `/${info.entriesField}`,
			message: `${COVERAGE_WARNING} ${Math.round(share * 100)}% of the chunk; check that no entry is missing. Unrelated text (prefaces, indexes, other content) and continuations of entries from the previous chunk legitimately lower coverage; keep valid entries and commit if nothing is missing`,
		},
	];
}

/**
 * Share of the chunk's words covered by the entries' verbatim fields (see coverageIssues). Undefined for schemas
 * without verbatim fields, data without entries, and chunks of fewer than three words.
 */
export function chunkCoverage(data: unknown, schema: LoadedSchema, chunkText: string): number | undefined {
	const fields = schema.rules.verbatimFields ?? [];
	if (fields.length === 0 || !data || typeof data !== "object") return undefined;
	const info = envelopeInfo(schema.schema);
	const entries = info.entriesField ? (data as Record<string, unknown>)[info.entriesField] : undefined;
	if (!Array.isArray(entries) || entries.length === 0) return undefined;
	const valueGrams = new Set<string>();
	entries.forEach((entry, index) => {
		for (const field of fields) {
			for (const found of valuesAtPath(entry, field.split("."), `/${info.entriesField}/${index}`)) {
				if (typeof found.value === "string")
					for (const gram of trigrams(groundingTokens(found.value))) valueGrams.add(gram);
			}
		}
	});
	const tokens = groundingTokens(chunkText);
	if (tokens.length < 3) return undefined;
	const covered = new Array<boolean>(tokens.length).fill(false);
	trigrams(tokens).forEach((gram, i) => {
		if (valueGrams.has(gram)) covered[i] = covered[i + 1] = covered[i + 2] = true;
	});
	return covered.filter(Boolean).length / tokens.length;
}

/** Warn when verbatim fields (per the schema's rules file) cannot be found in the source text. */
export function groundingIssues(
	data: unknown,
	schema: LoadedSchema,
	source: GroundingSource,
	threshold: number,
): Issue[] {
	const fields = schema.rules.verbatimFields ?? [];
	if (fields.length === 0 || !data || typeof data !== "object") return [];
	const info = envelopeInfo(schema.schema);
	const entries = info.entriesField ? (data as Record<string, unknown>)[info.entriesField] : undefined;
	if (!Array.isArray(entries)) return [];
	const issues: Issue[] = [];
	entries.forEach((entry, index) => {
		for (const field of fields) {
			for (const found of valuesAtPath(entry, field.split("."), `/${info.entriesField}/${index}`)) {
				if (typeof found.value !== "string" || found.value.trim() === "") continue;
				// Characters lost by a writer with the wrong encoding (ü written as U+FFFD), absent from the source.
				if (found.value.includes("�") && !source.hasReplacement) {
					issues.push({
						severity: "error",
						layer: "grounding",
						pointer: found.pointer,
						message:
							"contains U+FFFD replacement characters that the source text does not have: characters were lost, probably by a script that wrote the file in another encoding; restore them from the source and write the file as UTF-8",
					});
					continue;
				}
				const coverage = groundingCoverage(found.value, source);
				if (coverage < threshold) {
					issues.push({
						severity: "warning",
						layer: "grounding",
						pointer: found.pointer,
						message: `only ${Math.round(coverage * 100)}% of this verbatim field matches the source text; copy the source exactly (no normalization, no paraphrase)`,
					});
				}
			}
		}
	});
	return issues;
}
