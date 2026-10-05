import type { ChronoConfig, Mode, ToolName } from "../config.ts";
import type { ContextBundle } from "../context.ts";
import { boundaryPolicy, type LoadedSchema } from "../schemas/registry.ts";
import { canKeepNotes, listing } from "./notices.ts";
import type { InputKind } from "./state.ts";

export interface PromptOptions {
	mode: Mode;
	inputKind: InputKind;
	schema: LoadedSchema;
	config: ChronoConfig;
	/** The agent's tools; the prompt mentions only these. */
	tools: ReadonlySet<ToolName>;
	context: ContextBundle;
	documentLabel: string;
	totalUnits: number;
}

function schemaJson(schema: LoadedSchema): string {
	return JSON.stringify(schema.schema);
}

function contextSection(context: ContextBundle): string {
	if (context.texts.length === 0 && context.images.length === 0) return "";
	const parts = ["## Source context (provided by the user)"];
	for (const text of context.texts) parts.push(text.content);
	if (context.images.length > 0) {
		parts.push(
			`${context.images.length} context image(s) (e.g. sample pages, alphabets of the hand, reference material) are attached to the first message of the session and again after every compaction. They are not pages of this document.`,
		);
	}
	return parts.join("\n\n");
}

function workflowSection(options: PromptOptions, unitWord: string): string {
	const { config, tools } = options;
	const writers = (["write", "edit", "add_entries", "update_entry"] as const).filter((name) => tools.has(name));
	const remaining = [...writers, "verify", ...(tools.has("read") ? ["reading your own unit file or notes.md"] : [])];
	const notes = canKeepNotes(tools);
	const steps = tools.has("add_entries")
		? " A long unit may be built in several steps (add_entries in batches) before committing."
		: tools.has("edit") && tools.has("write")
			? " A long unit may be written in several steps (write a first part, then append further entries with edit) before committing."
			: "";
	return `## How the work is organized
- The document is divided into units (${unitWord}s) with ids such as ${options.inputKind === "images" ? "p0007" : "c0007"}. The harness gives you one unit at a time in a message.
- Finish the current unit completely before anything else: complete its file, check it, and commit it by calling \`verify\` with final=true. Only then does the next unit arrive. Later units cannot be opened before.
- verify final=true ends the unit irreversibly: a committed unit cannot be changed or extended afterwards. Call it only when the file is complete.${steps}
- After a commit, the conversation may be compacted: earlier messages are replaced by a short state summary. Anything you need later must be in the committed unit files${notes ? " or in notes.md" : ""}.
- Each unit has a budget of ${config.toolSoftCap} tool calls. After that only ${listing(remaining)} remain; at ${config.toolHardCap} calls the unit is closed and flagged for human review. Spend the budget where it improves accuracy.${
		notes
			? "\n- Keep notes.md short and current: abbreviations and how you render them, letter forms, recurring names and terms, running heads, layout habits, conventions you settled on. It is shown to you after every compaction and at the start of later sessions."
			: ""
	}
- Work autonomously; there is no user to answer questions. When the session's last unit is committed, stop.`;
}

function toolsSection(options: PromptOptions): string {
	const { tools } = options;
	const lines = ["## Tools"];
	if (options.inputKind === "images" && tools.has("view")) {
		lines.push(
			"- view: the current page is attached to its unit message at the highest resolution the model accepts, so you do not need to view it whole again. `box` ({x, y, w, h} as fractions of page width and height, origin top-left) zooms into a region at full resolution; `grid: true` overlays labelled coordinates to help choose boxes; `enhance` (contrast, grayscale, sharpen, threshold, invert) and `rotate` help with faint, stained or rotated text. The previous and the next page can be viewed with `unit` (catchwords, words or entries running across pages).",
		);
		lines.push(
			"- To keep requests small, images of earlier units are removed from the conversation once their unit is committed; view a page again if you need it.",
		);
	}
	const fileTools = (["write", "edit"] as const).filter((name) => tools.has(name));
	if (fileTools.length > 0) {
		lines.push(
			`- ${fileTools.join(" / ")}: ${tools.has("write") ? "create and correct" : "correct"} the current unit's file (and notes.md, or scratch files under scratch/).${fileTools.length === 2 ? " Prefer edit for corrections instead of rewriting the whole file." : ""}`,
		);
	}
	if (tools.has("add_entries")) {
		const fix = tools.has("update_entry")
			? "Fix single fields of an entry with update_entry; replace a whole entry with remove=[n] plus the corrected entry at position=n, so the order is kept"
			: "Fix a wrong entry with remove=[n] plus the corrected entry at position=n, so the order is kept";
		lines.push(
			`- add_entries: append entries to the current unit file (created if missing) in batches of 1-3 entries per call, in source order, without resending earlier entries. Invalid entries are not added and get rejection IDs (R1, ...); resend each corrected with resolves=["R1"] and the position shown for it, or drop it with resolves alone. ${fix}; never empty the file to start over. The unit file can be long: use the numbered index at the end of every add_entries result instead of reading the file.`,
		);
	}
	if (tools.has("update_entry")) {
		lines.push(
			'- update_entry: change fields of one entry of the current unit file by its number, e.g. after a grounding warning: changes=[{path: "/title_original", value: "..."}] (JSON pointers within the entry; "-" appends to an array). The changed entry must still match the schema, otherwise nothing changes.',
		);
	}
	if (tools.has("read")) {
		lines.push(
			options.inputKind === "text"
				? "- read: re-read the source (source/<unit>.txt, with offset/limit for a passage; the previous chunk and up to two chunks ahead are readable), your unit file, notes.md, or committed units in units/."
				: "- read: re-read your unit file, notes.md, or committed units in units/.",
		);
	}
	if (tools.has("bash")) {
		lines.push(
			'- bash: shell in the work directory for small checks (e.g. grep across committed units, counting entries). Committed units are final: changes made to them later are discarded. Files written from bash scripts must be UTF-8 (Python: open(path, "w", encoding="utf-8")).',
		);
	}
	lines.push(
		"- verify: checks the current unit file (parsing, JSON Schema, consistency rules, suspicious repetitions" +
			(options.inputKind === "text" ? ", and whether verbatim fields occur in the source text" : "") +
			"). Without final it only reports; with final=true it commits the unit if there are no errors. Warnings do not block a commit, but resolve them when they point to real problems.",
	);
	return lines.join("\n");
}

/**
 * How to mark doubtful readings: the schema's own uncertainty rule when its body description has one, no markup
 * when it asks for raw text only, and the <unclear>/<gap/> markers otherwise.
 */
export function uncertaintyInstruction(bodyRules: string): string {
	const rule = bodyRules
		.split("\n")
		.map((line) => line.replace(/^\s*-\s*/, "").trim())
		.find((line) => /^uncertain/i.test(line) || /\billegible\b/i.test(line));
	if (rule) return `Mark remaining doubt as the transcription rules prescribe (${rule}). Never guess silently.`;
	if (/\b(raw|plain) text only\b/i.test(bodyRules)) {
		return "This schema allows no markup: give your best reading, and record doubtful passages in notes.md. Never guess silently.";
	}
	return "Mark remaining doubt with <unclear>…</unclear> (best reading inside) or <gap/>. Never guess silently.";
}

function transcriptionPrompt(options: PromptOptions): string {
	const bodyField = options.schema.rules.bodyField ?? "transcription";
	const props = (options.schema.schema.properties ?? {}) as Record<string, { description?: string; type?: unknown }>;
	const bodyRules = props[bodyField]?.description ?? "";
	const frontFields = Object.keys(props).filter((key) => key !== bodyField);
	const frontExample = frontFields
		.map((key) => {
			const type = props[key]?.type;
			if (type === "boolean") return `${key}: false`;
			if (key === "image_analysis")
				return `${key}: |\n  <layout, columns, typeface or hand, languages, page number and catchword position, damage>`;
			return `${key}: |\n  <${key}>`;
		})
		.join("\n");
	return `You are Mabillon, an expert transcriber of historical documents: manuscripts, early modern print, Fraktur and blackletter, tables and forms. You work through the pages of ${options.documentLabel} (${options.totalUnits} pages) one page at a time and produce a faithful transcription of each page as a file that is validated against a JSON schema.

${workflowSection(options, "page")}

${toolsSection(options)}

## Unit file
The transcription of page p0007 goes to units/p0007.md in this form:

\`\`\`
---
${frontExample}
---
<the transcription of the page>
\`\`\`

The front matter (YAML) holds every schema field except \`${bodyField}\`; the text below it is the \`${bodyField}\` field. Use \`key: |\` blocks for free text. For a page without text, set no_transcribable_text: true and leave the body empty. Set transcription_not_possible: true only when the page has text that cannot be transcribed at all (e.g. destroyed or completely illegible); the body must then be empty as well.

## Method for each page
1. Study the full page attached to the unit message: layout, columns, script, marginalia, page number, catchword, signature mark.
2. Transcribe the page in reading order into the unit file.
3. Compare the draft line by line with the image.${
		options.tools.has("view")
			? " Zoom into every passage you are unsure about: small or faint type, abbreviations, numerals, names, marginalia, damage."
			: ""
	} Correct the file with ${options.tools.has("edit") ? "edit" : options.tools.has("write") ? "write" : "bash"}.
4. ${uncertaintyInstruction(bodyRules)}
5. Run verify, fix all errors, then verify with final=true.

## Transcription rules
${bodyRules}
- Faithfulness comes before fluency. Historical spellings, inconsistent spellings and apparent errors are part of the source; reproduce them. Be especially careful with short common words, where modern spellings creep in (e.g. "vnto", "haue", "ſo"), and with names and numbers.
- Do not complete text from memory of similar books, and do not translate or summarize.

## Schema (${options.schema.name})
The unit's data must validate against this JSON Schema:
${schemaJson(options.schema)}

${contextSection(options.context)}`.trim();
}

/** How the agent corrects a single entry with the tools it has. */
function correctionTools(options: PromptOptions): string {
	const { tools } = options;
	if (tools.has("update_entry")) {
		return tools.has("add_entries")
			? "update_entry for single fields, add_entries remove plus position for whole entries"
			: `update_entry${tools.has("edit") ? " or edit" : ""}`;
	}
	if (tools.has("add_entries")) {
		return `add_entries (remove plus the corrected entry at the same position)${tools.has("edit") ? " or edit" : ""}`;
	}
	return tools.has("edit") ? "edit" : tools.has("write") ? "write" : "bash";
}

function extractionPrompt(options: PromptOptions): string {
	const isImages = options.inputKind === "images";
	const unitWord = isImages ? "page" : "chunk";
	const example = isImages ? "p0007" : "c0007";
	return `You are Mabillon, an expert in extracting structured data from historical documents. You work through ${options.documentLabel} (${options.totalUnits} ${unitWord}s) one ${unitWord} at a time and record every entry of the kind defined by the schema below, as JSON validated against that schema.

${workflowSection(options, unitWord)}

${toolsSection(options)}

## Unit file
The data for ${unitWord} ${example} goes to units/${example}.json: one JSON object that conforms to the schema${
		"entries" in ((options.schema.schema.properties ?? {}) as object)
			? ', typically {"contains_no_content_of_requested_type": false, "entries": [...]}. If the ' +
				unitWord +
				" has nothing of the requested kind, set contains_no_content_of_requested_type to true and entries to []"
			: ""
	}.

## Entries that cross ${unitWord} boundaries
${
	boundaryPolicy(options.schema) === "fragments"
		? `- Record what this ${unitWord} shows: an entry that begins on an earlier ${unitWord} or continues onto the next one is recorded here as its own entry with only this ${unitWord}'s part, flagged as a fragment (the schema's fragment field). Fields whose evidence is outside this ${unitWord} are null.
- Do not complete fragments from neighboring ${unitWord}s and do not skip continuations at the top of a ${unitWord}; do not pass \`carry_over\`.`
		: `- An entry belongs to the ${unitWord} where it begins. If it continues into the next ${unitWord}, ${
				// view (image units) and read (text units) are mandatory tools, so the next unit can always be looked at.
				isImages
					? "view the next page (view with unit=<next id>) to complete it, record the complete entry in the current unit,"
					: "read the next chunk (source/<next id>.txt; the unit message already shows its first lines, and you may read up to two chunks ahead) to complete it, record the complete entry in the current unit,"
			} and pass \`carry_over\` to verify(final=true) describing where the continuation ends in the next ${unitWord} (quote its last words).
- If a ${unitWord} begins with the continuation of an entry recorded in the previous unit, the carry-over note in the unit message tells you; skip that part.`
}

## Method for each ${unitWord}
1. ${isImages ? "Study the page attached to the unit message and locate" : "Read the chunk and locate"} every entry of the requested kind, top to bottom${isImages ? ", including margins" : ""}.
2. ${
		options.tools.has("add_entries")
			? `Add all entries with add_entries, 1-3 per call in source order, following the field descriptions in the schema exactly${options.tools.has("write") ? " (write the whole file only if that is simpler, e.g. for an empty unit)" : ""}.`
			: `${options.tools.has("write") ? "Write" : "Create (with bash)"} the unit file with all entries, following the field descriptions in the schema exactly.`
	}
3. Check every field against the ${isImages ? (options.tools.has("view") ? "image (zoom into names, numbers, abbreviations and faint passages)" : "image") : "source text"}; correct with ${correctionTools(options)}.
4. Run verify, fix all errors, then verify with final=true once the ${unitWord} is fully covered.

## Extraction rules
- The schema's field descriptions define what each field means and how to fill it; they override habits.
- Use null where the schema allows it and the source gives no value. Never invent values.
- Fields described as verbatim or original must reproduce the source exactly (spelling, abbreviations, punctuation, line content); normalized, modernized or translated forms belong only in fields meant for them.
- Do not drop entries: long ${unitWord}s often contain many entries. Count them before you commit.

## Schema (${options.schema.name})
${schemaJson(options.schema)}

${contextSection(options.context)}`.trim();
}

export function buildSystemPrompt(options: PromptOptions): string {
	return options.mode === "transcribe" ? transcriptionPrompt(options) : extractionPrompt(options);
}
