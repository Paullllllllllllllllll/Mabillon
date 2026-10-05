import type { LoadedSchema } from "../schemas/registry.ts";
import { countIssues, type Issue } from "./issues.ts";
import {
	allowedTranscriptionTags,
	buildGroundingSource,
	coverageIssues,
	envelopeIssues,
	groundingIssues,
	markerIssues,
	parseJsonUnit,
	parseTranscriptionUnit,
	qualityIssues,
	transcriptionFlagIssues,
} from "./rules.ts";
import { compileSchema, schemaIssues } from "./validate.ts";

export interface VerifyOptions {
	schema: LoadedSchema;
	/** Raw content of the unit file (front matter + body for transcription, JSON for extraction). */
	content: string;
	/** Source text for grounding verbatim fields (text extraction only). */
	sourceText?: string;
	groundingThreshold?: number;
	/** Text of the unit's own chunk (without look-ahead), for the coverage check of text extraction. */
	chunkText?: string;
}

/** Share of a verbatim field's word trigrams that must occur in the source (default of grounding_threshold). */
export const GROUNDING_THRESHOLD = 0.8;
/**
 * Share of a chunk's words that the entries' verbatim fields must cover before a missing-entries warning. Complete
 * extractions cover nearly all of a recipe chunk; at 0.5, two of four equally long recipes would just pass.
 */
export const CHUNK_COVERAGE_THRESHOLD = 0.6;

export interface VerifyResult {
	data?: unknown;
	issues: Issue[];
	errors: number;
	warnings: number;
}

function finish(data: unknown, issues: Issue[]): VerifyResult {
	return { data, issues, ...countIssues(issues) };
}

/** Schema, flag, quality, and marker checks of one transcribed page, given as the schema object. */
function transcriptionIssues(schema: LoadedSchema, data: Record<string, unknown>): Issue[] {
	const validate = compileSchema(schema.schema, `${schema.name}:${schema.sha256}`);
	const body = data[schema.rules.bodyField ?? "transcription"];
	return [
		...schemaIssues(validate, data),
		...transcriptionFlagIssues(data, schema.rules.bodyField ?? "transcription"),
		...qualityIssues(data),
		...markerIssues(typeof body === "string" ? body : "", allowedTranscriptionTags(schema)),
	];
}

/** Run all checks on one unit file. */
export function verifyUnitContent(options: VerifyOptions): VerifyResult {
	const { schema } = options;
	if (schema.kind === "transcription") {
		const parsed = parseTranscriptionUnit(options.content, schema);
		if (!parsed.data) return finish(undefined, parsed.issues);
		return finish(parsed.data, [...parsed.issues, ...transcriptionIssues(schema, parsed.data)]);
	}
	const validate = compileSchema(schema.schema, `${schema.name}:${schema.sha256}`);
	const parsed = parseJsonUnit(options.content);
	if (parsed.data === undefined) return finish(undefined, parsed.issues);
	const issues = [
		...schemaIssues(validate, parsed.data),
		...envelopeIssues(parsed.data, schema.schema),
		...qualityIssues(parsed.data),
	];
	if (options.sourceText !== undefined) {
		issues.push(
			...groundingIssues(
				parsed.data,
				schema,
				buildGroundingSource(options.sourceText),
				options.groundingThreshold ?? GROUNDING_THRESHOLD,
			),
		);
	}
	if (options.chunkText !== undefined) {
		issues.push(...coverageIssues(parsed.data, schema, options.chunkText, CHUNK_COVERAGE_THRESHOLD));
	}
	return finish(parsed.data, issues);
}

/** Run the unit checks of a transcription on a page already parsed into the schema object (e.g. an exported page). */
export function verifyTranscriptionPage(schema: LoadedSchema, data: Record<string, unknown>): VerifyResult {
	return finish(data, transcriptionIssues(schema, data));
}

/** Validate an already-parsed object (e.g. a merged final output) against the schema and envelope rules. */
export function verifyObject(schema: LoadedSchema, data: unknown): VerifyResult {
	const validate = compileSchema(schema.schema, `${schema.name}:${schema.sha256}`);
	const issues = [...schemaIssues(validate, data)];
	if (schema.kind === "extraction") issues.push(...envelopeIssues(data, schema.schema));
	return finish(data, issues);
}
