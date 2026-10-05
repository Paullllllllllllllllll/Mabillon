import {
	entryItemSchema,
	envelopeInfo,
	inlineSchema,
	type JsonSchema,
	type LoadedSchema,
	propertyPointer,
	rootPartSchema,
} from "../schemas/registry.ts";
import { compileSchema, schemaIssues } from "../verify/validate.ts";

/**
 * The add_entries tool of extraction mode: changes the current unit file by explicit operations, so the model never
 * has to resend or re-read the whole file (write replaces everything, edit needs exact matches, and pi's read
 * truncates long files). It removes entries by number, appends new ones, sets other top-level fields, and resolves
 * earlier rejections. New entries are validated one by one; invalid ones get rejection IDs (R1, R2, ...) that stay
 * pending until a later call names them in `resolves`.
 */

/** Above this size the tool declares generic entry objects instead of the schema's item schema. */
export const MAX_TOOL_SCHEMA_CHARS = 60_000;
const MAX_ERRORS_PER_ENTRY = 5;
const LABEL_LENGTH = 60;

/** Start of the verify warning about rejections that no later add_entries call resolved. */
export const PENDING_REJECTIONS_WARNING = "add_entries rejections not resolved";

export interface AddEntriesSetup {
	/** JSON Schema of the tool's parameters, as declared to the model. */
	parameters: JsonSchema;
	/** The entry structure could not be declared (recursive $refs, too large); entries are declared as objects. */
	generic: boolean;
	entriesField: string;
	emptyFlag?: string;
	otherFields: string[];
	/** Schema errors of one entry (empty when valid). */
	entryErrors(entry: unknown): string[];
	/** Schema errors of the `fields` object (empty when valid). */
	fieldErrors(fields: unknown): string[];
	/** Property order of the schema's top level. */
	order: string[];
	/** Short label of an entry for indexes: the start of its first verbatim or title-like field. */
	entryLabel(entry: unknown): string;
}

export interface AddEntriesArgs {
	entries?: unknown[];
	fields?: Record<string, unknown>;
	/** 1-based numbers of entries in the current file to remove (before appending). */
	remove?: number[];
	/** 1-based position (in the file after the removals) where the new entries are inserted; default: the end. */
	position?: number;
	/** Rejection IDs (R1, ...) this call settles: corrected entries are in `entries`, or the entry is dropped. */
	resolves?: string[];
	/** Set by prepareArguments: entries that failed validation, by 1-based position in the call. */
	rejected_entries?: Array<{ position: number; errors: string[]; entry: unknown }>;
	rejected_fields?: string[];
}

/**
 * The tool setup, or why there is none for a schema that has an entries array (the session then runs without
 * add_entries). Cached per schema.
 */
const setups = new Map<string, { setup?: AddEntriesSetup; error?: string }>();

export function resolveAddEntries(schema: LoadedSchema): { setup?: AddEntriesSetup; error?: string } {
	const key = `${schema.path}:${schema.sha256}`;
	let resolved = setups.get(key);
	if (!resolved) {
		try {
			resolved = { setup: addEntriesSetup(schema) };
		} catch (error) {
			resolved = { error: error instanceof Error ? error.message : String(error) };
		}
		setups.set(key, resolved);
	}
	return resolved;
}

function errorsOf(validate: ReturnType<typeof compileSchema>, value: unknown): string[] {
	const issues = schemaIssues(validate, value, MAX_ERRORS_PER_ENTRY);
	return issues.map((issue) => `${issue.pointer && issue.pointer !== "/" ? `${issue.pointer} ` : ""}${issue.message}`);
}

function label(entry: unknown, labelFields: string[]): string {
	let text: string | undefined;
	if (entry && typeof entry === "object") {
		for (const path of labelFields) {
			let value: unknown = entry;
			for (const part of path.split(".")) {
				value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
			}
			if (typeof value === "string" && value.trim()) {
				text = value;
				break;
			}
		}
	}
	const flat = (text ?? JSON.stringify(entry) ?? "").replace(/\s+/g, " ").trim();
	return flat.length > LABEL_LENGTH ? `${flat.slice(0, LABEL_LENGTH)}…` : flat;
}

/** The tool setup for an extraction schema with an entries array; undefined for other schemas. */
export function addEntriesSetup(schema: LoadedSchema): AddEntriesSetup | undefined {
	if (schema.kind !== "extraction") return undefined;
	const root = schema.schema;
	const info = envelopeInfo(root);
	const items = entryItemSchema(root);
	if (!info.entriesField) return undefined;
	const props = (root.properties ?? {}) as Record<string, JsonSchema>;
	// Validated against the root as written, so that every local $ref of the schema resolves.
	const validateEntry = compileSchema(
		rootPartSchema(root, items ? { $rootPointer: items.pointer } : {}),
		`${schema.name}:${schema.sha256}:entry`,
	);
	const validateFields = compileSchema(
		rootPartSchema(root, {
			type: "object",
			properties: Object.fromEntries(info.otherFields.map((key) => [key, { $rootPointer: propertyPointer(key) }])),
			additionalProperties: false,
		}),
		`${schema.name}:${schema.sha256}:fields`,
	);

	const declaredItem = items ? (inlineSchema(root, items.schema) as JsonSchema | undefined) : undefined;
	// Inlined inside a properties wrapper: field names such as "title" or "description" are not keywords there.
	const fieldProps = Object.fromEntries(info.otherFields.map((key) => [key, props[key]]));
	const declaredFields = (inlineSchema(root, { properties: fieldProps }) as JsonSchema | undefined)?.properties as
		| JsonSchema
		| undefined;
	const build = (item: JsonSchema | undefined, fields: JsonSchema | undefined): JsonSchema => {
		const properties: JsonSchema = {
			entries: {
				type: "array",
				items: item ?? { type: "object" },
				description:
					"New entries for the current unit, in source order, each in the structure of the schema's entries. They are appended to the unit file.",
			},
			remove: {
				type: "array",
				items: { type: "integer" },
				description:
					"Numbers of entries in the current file (as in the index of the last add_entries result) to delete; applied before new entries are appended.",
			},
			position: {
				type: "integer",
				description:
					"Optional: 1-based position in the file (after the removals) where the new entries are inserted, e.g. the number of a removed entry to put its correction in its place. Default: the end.",
			},
			resolves: {
				type: "array",
				items: { type: "string" },
				description:
					"Rejection IDs (R1, R2, ...) this call settles: with the corrected entries in `entries`, or alone to drop the rejected entry.",
			},
		};
		if (info.otherFields.length > 0) {
			properties.fields = {
				type: "object",
				properties: fields ?? Object.fromEntries(info.otherFields.map((key) => [key, {}])),
				additionalProperties: false,
				description: `Optional: the unit's other top-level fields (${info.otherFields.join(", ")}).`,
			};
		}
		return { type: "object", properties };
	};
	let parameters = build(declaredItem, declaredFields);
	let generic = declaredItem === undefined;
	if (JSON.stringify(parameters).length > MAX_TOOL_SCHEMA_CHARS) {
		parameters = build(undefined, undefined);
		generic = true;
	}
	// Index labels: verbatim fields (title-like ones first), then title- or name-like fields of the entry.
	const verbatim = schema.rules.verbatimFields ?? [];
	const titleLike = (path: string) => /title|name|heading/i.test(path);
	const itemProps = Object.keys((items?.schema.properties ?? {}) as object);
	const labelFields = [
		...verbatim.filter(titleLike),
		...verbatim.filter((path) => !titleLike(path)),
		...itemProps.filter((name) => titleLike(name) && !verbatim.includes(name)),
	];
	return {
		parameters,
		generic,
		entriesField: info.entriesField,
		emptyFlag: info.emptyFlag,
		otherFields: info.otherFields,
		entryErrors: (entry) =>
			entry && typeof entry === "object" && !Array.isArray(entry)
				? errorsOf(validateEntry, entry)
				: ["must be an object"],
		fieldErrors: (fields) => errorsOf(validateFields, fields),
		order: Object.keys(props),
		entryLabel: (entry) => label(entry, labelFields),
	};
}

/**
 * Runs before pi checks the arguments against the declared schema: invalid entries (and invalid fields) are moved
 * out of the way, so that the valid ones of the same call are still added and the rest are reported individually.
 */
export function partitionArguments(setup: AddEntriesSetup, args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	// The bookkeeping keys are Mabillon's own; values the model sends under these names are dropped.
	const { rejected_entries: _entries, rejected_fields: _fields, ...input } = args as Record<string, unknown>;
	const prepared: Record<string, unknown> = { ...input };
	if (Array.isArray(input.entries)) {
		const entries: unknown[] = [];
		const rejected: Array<{ position: number; errors: string[]; entry: unknown }> = [];
		input.entries.forEach((entry, index) => {
			const errors = setup.entryErrors(entry);
			if (errors.length === 0) entries.push(entry);
			else rejected.push({ position: index + 1, errors, entry });
		});
		prepared.entries = entries;
		if (rejected.length > 0) prepared.rejected_entries = rejected;
	}
	if (input.fields !== undefined) {
		const errors = setup.fieldErrors(input.fields);
		if (errors.length > 0) {
			delete prepared.fields;
			prepared.rejected_fields = errors;
		}
	}
	return prepared;
}

/**
 * The unit object after removing the entries numbered in `remove` (1-based, in the current file) and appending
 * `entries`: the existing file's object, or a new envelope. Any out-of-range number fails the whole change.
 */
export function updateEntries(
	setup: AddEntriesSetup,
	existing: string | undefined,
	change: { remove?: number[]; entries?: unknown[]; fields?: Record<string, unknown>; position?: number },
): { data?: Record<string, unknown>; error?: string; insertedAt?: number } {
	let data: Record<string, unknown>;
	if (existing === undefined || existing.trim() === "") {
		data = {};
		for (const key of setup.order) {
			if (key === setup.entriesField) data[key] = [];
			else if (key === setup.emptyFlag) data[key] = false;
			else data[key] = null;
		}
	} else {
		let parsed: unknown;
		try {
			parsed = JSON.parse(existing);
		} catch {
			return { error: "is not valid JSON; fix or rewrite it with write before using add_entries" };
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { error: "does not hold a JSON object; rewrite it with write before using add_entries" };
		}
		data = parsed as Record<string, unknown>;
	}
	const value = data[setup.entriesField];
	// A missing or null list is started; any other non-array value is the agent's data and is not overwritten.
	if (value !== undefined && value !== null && !Array.isArray(value)) {
		return {
			error: `has an \`${setup.entriesField}\` value that is not an array; fix it with edit or rewrite it with write`,
		};
	}
	const current = Array.isArray(value) ? value : [];
	const remove = [...new Set(change.remove ?? [])];
	const outOfRange = remove.filter((number) => !Number.isInteger(number) || number < 1 || number > current.length);
	if (outOfRange.length > 0) {
		return {
			error: `has ${current.length} entries; no entry ${outOfRange.join(", ")} to remove`,
		};
	}
	const kept = current.filter((_, index) => !remove.includes(index + 1));
	const position = change.position ?? kept.length + 1;
	if (!Number.isInteger(position) || position < 1 || position > kept.length + 1) {
		return {
			error: `has ${kept.length} entries${remove.length > 0 ? " after the removals" : ""}; position ${change.position} is outside 1-${kept.length + 1}`,
		};
	}
	data[setup.entriesField] = [...kept.slice(0, position - 1), ...(change.entries ?? []), ...kept.slice(position - 1)];
	if (change.fields) Object.assign(data, change.fields);
	if (setup.emptyFlag && (data[setup.entriesField] as unknown[]).length > 0) data[setup.emptyFlag] = false;
	return { data, insertedAt: position };
}

/**
 * The slot of a pending rejection after a call: removed entries before it close up, entries inserted before it push
 * it down. A slot is the 1-based position the entry would take if inserted. Entries inserted at the same slot push
 * it down only when `follows` is set: the call resolved an earlier rejection of the same slot (the inserted entry
 * belongs before this one); otherwise the rejected entry keeps its place before them.
 */
export function shiftSlot(
	slot: number,
	removed: number[],
	insertedAt: number,
	inserted: number,
	follows = false,
): number {
	let shifted = slot - removed.filter((number) => number < slot).length;
	if (inserted > 0 && (insertedAt < shifted || (insertedAt === shifted && follows))) shifted += inserted;
	return shifted;
}

export interface EntryChange {
	/** JSON pointer within the entry, e.g. "/title_original" or "/ingredients/2/quantity_original". */
	path: string;
	value: unknown;
}

/** Parameters of the update_entry tool. */
export const UPDATE_ENTRY_PARAMETERS: JsonSchema = {
	type: "object",
	properties: {
		number: { type: "integer", description: "1-based number of the entry in the current unit file (see the index)." },
		changes: {
			type: "array",
			description:
				'Changes to the entry: {path, value} with path a JSON pointer within the entry ("/title_original", "/ingredients/2/quantity_original"; "-" as the last part appends to an array) and value any JSON value, including null. Missing object keys are added; array indexes must exist.',
			items: {
				type: "object",
				properties: { path: { type: "string" }, value: {} },
				required: ["path", "value"],
			},
		},
	},
	required: ["number", "changes"],
};

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function pointerParts(path: string): string[] | undefined {
	if (!path.startsWith("/")) return undefined;
	return path
		.slice(1)
		.split("/")
		.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Apply `changes` to a copy of entry `number` (1-based) of the unit file and validate the result against the entry
 * schema. Returns the new unit object and entry, or the errors (then nothing is to be written).
 */
export function updateEntry(
	setup: AddEntriesSetup,
	existing: string | undefined,
	number: number,
	changes: EntryChange[],
): { data?: Record<string, unknown>; entry?: unknown; errors?: string[] } {
	if (existing === undefined || existing.trim() === "") return { errors: ["the unit file does not exist yet"] };
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(existing) as Record<string, unknown>;
	} catch {
		return { errors: ["the unit file is not valid JSON; fix or rewrite it first"] };
	}
	const entries = data && typeof data === "object" ? data[setup.entriesField] : undefined;
	if (!Array.isArray(entries)) return { errors: [`the unit file has no \`${setup.entriesField}\` array`] };
	if (!Number.isInteger(number) || number < 1 || number > entries.length) {
		return { errors: [`there is no entry ${number} (the file has ${entries.length})`] };
	}
	if (changes.length === 0) return { errors: ["no changes given"] };
	const entry = structuredClone(entries[number - 1]) as unknown;
	const errors: string[] = [];
	for (const change of changes) {
		const parts = typeof change?.path === "string" ? pointerParts(change.path) : undefined;
		if (!parts || parts.length === 0 || parts.some((part) => part === "")) {
			errors.push(`${change?.path}: a path is a JSON pointer such as "/title_original"`);
			continue;
		}
		// Prototype keys would reach outside the entry's own data.
		if (parts.some((part) => FORBIDDEN_KEYS.has(part))) {
			errors.push(`${change.path}: __proto__, constructor and prototype cannot be set`);
			continue;
		}
		if (!Object.hasOwn(change, "value")) {
			errors.push(`${change.path}: a value is required (null to clear a field)`);
			continue;
		}
		let parent: unknown = entry;
		let failed = false;
		for (const part of parts.slice(0, -1)) {
			// Own properties and existing array items only.
			const next = Array.isArray(parent)
				? /^\d+$/.test(part)
					? parent[Number(part)]
					: undefined
				: parent && typeof parent === "object" && Object.hasOwn(parent, part)
					? (parent as Record<string, unknown>)[part]
					: undefined;
			if (next === undefined || next === null || typeof next !== "object") {
				errors.push(`${change.path}: ${part} does not exist`);
				failed = true;
				break;
			}
			parent = next;
		}
		if (failed) continue;
		const last = parts[parts.length - 1];
		const value = structuredClone(change.value);
		if (Array.isArray(parent)) {
			if (last === "-") parent.push(value);
			else if (/^\d+$/.test(last) && Number(last) < parent.length) parent[Number(last)] = value;
			else
				errors.push(
					`${change.path}: index ${last} does not exist (the array has ${parent.length} items; "-" appends)`,
				);
		} else if (parent && typeof parent === "object") {
			// An own data property, whatever the key (no setters, no prototype).
			Object.defineProperty(parent, last, { value, writable: true, enumerable: true, configurable: true });
		} else {
			errors.push(`${change.path}: the parent is not an object or array`);
		}
	}
	if (errors.length > 0) return { errors };
	const schemaErrors = setup.entryErrors(entry);
	if (schemaErrors.length > 0) return { errors: schemaErrors };
	const updated = [...entries];
	updated[number - 1] = entry;
	return { data: { ...data, [setup.entriesField]: updated }, entry };
}

/** The sequence number of a rejection ID (R12 -> 12). */
export function rejectionNumber(id: string): number {
	return Number.parseInt(id.slice(1), 10);
}

/**
 * Numbered index of the file's entries, for targeting `remove` and `position` without reading the file, with the
 * slots of pending rejections where their corrected entries belong.
 */
export function entryIndex(
	setup: AddEntriesSetup,
	data: Record<string, unknown>,
	slots: Array<{ id: string; position: number }> = [],
): string {
	const entries = (data[setup.entriesField] as unknown[]) ?? [];
	const lines = ["Entries:"];
	const slotLines = (position: number) =>
		slots
			.filter((slot) => slot.position === position)
			.map((slot) => `   [${slot.id} belongs here: resend it with position=${position}]`);
	entries.forEach((entry, index) => {
		lines.push(...slotLines(index + 1), `${index + 1}. ${setup.entryLabel(entry)}`);
	});
	lines.push(...slotLines(entries.length + 1));
	return lines.length === 1 ? "Entries: none." : lines.join("\n");
}
