import type { ErrorObject, ValidateFunction } from "ajv";
import Ajv2020Module from "ajv/dist/2020.js";
import type { Issue } from "./issues.ts";

type Ajv2020Instance = InstanceType<typeof Ajv2020Module.default>;

const Ajv2020Class = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as new (
	options: Record<string, unknown>,
) => Ajv2020Instance;

const compiled = new Map<string, ValidateFunction>();

/**
 * Compile (and cache) a JSON Schema. Each schema gets its own Ajv instance, so `$id`s (and self-references through
 * them) are kept without clashing between schemas. Throws with a readable message if the schema is invalid.
 */
export function compileSchema(schema: Record<string, unknown>, cacheKey: string): ValidateFunction {
	let validate = compiled.get(cacheKey);
	if (!validate) {
		try {
			// $schema is dropped so draft-07 and 2020-12 schemas both compile with the 2020-12 validator.
			const { $schema: _schema, ...rest } = schema;
			// ownProperties: inherited properties never satisfy `required` or `properties`.
			const ajv = new Ajv2020Class({
				allErrors: true,
				strict: false,
				validateFormats: false,
				verbose: false,
				ownProperties: true,
			});
			validate = ajv.compile(rest);
		} catch (error) {
			throw new Error(`Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
		}
		compiled.set(cacheKey, validate);
	}
	return validate;
}

function describe(error: ErrorObject): string {
	const params = error.params as Record<string, unknown>;
	switch (error.keyword) {
		case "additionalProperties":
			return `unexpected property "${String(params.additionalProperty)}"`;
		case "required":
			return `missing required property "${String(params.missingProperty)}"`;
		case "enum": {
			const allowed = (params.allowedValues as unknown[]).map((value) => JSON.stringify(value));
			const shown = allowed.length > 15 ? [...allowed.slice(0, 15), "…"] : allowed;
			return `must be one of ${shown.join(", ")}`;
		}
		case "type":
			return `must be ${String(params.type)}`;
		case "const":
			return `must equal ${JSON.stringify(params.allowedValue)}`;
		default:
			return error.message ?? error.keyword;
	}
}

/** Validate data against a compiled schema; return schema-layer issues (deduplicated, capped). */
export function schemaIssues(validate: ValidateFunction, data: unknown, max = 30): Issue[] {
	if (validate(data)) return [];
	const errors = validate.errors ?? [];
	// anyOf/oneOf summaries repeat what the branch errors already say; keep them only if nothing else is reported.
	const specific = errors.filter((error) => error.keyword !== "anyOf" && error.keyword !== "oneOf");
	const chosen = specific.length > 0 ? specific : errors;
	const seen = new Set<string>();
	const issues: Issue[] = [];
	for (const error of chosen) {
		const pointer = error.instancePath || "/";
		const message = describe(error);
		const key = `${pointer} ${message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		issues.push({ severity: "error", layer: "schema", pointer, message });
	}
	if (issues.length > max) {
		const rest = issues.length - max;
		return [
			...issues.slice(0, max),
			{ severity: "error", layer: "schema", message: `…and ${rest} more schema errors (fix the ones above first)` },
		];
	}
	return issues;
}
