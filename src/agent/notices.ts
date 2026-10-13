import type { ToolName } from "../config.ts";

/**
 * Texts the harness sends to the agent about its unit work (refusals, hints, instructions). They mention only the
 * tools the agent has, so tool ablations differ in the tool set alone.
 */

type Tools = ReadonlySet<ToolName>;

/** The tools that change the unit file, in a fixed order. */
function fileTools(tools: Tools): ToolName[] {
	return (["write", "edit", "add_entries", "update_entry", "bash"] as const).filter((name) => tools.has(name));
}

/** "a, b and c" */
export function listing(items: string[]): string {
	return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** How the agent creates or rewrites a unit file with the tools it has. */
function createWith(tools: Tools): string {
	if (tools.has("write")) return "write";
	if (tools.has("add_entries")) return "add_entries";
	return "bash";
}

/** The last line of a unit message. */
export function closingInstruction(tools: Tools, file: string, mode: "transcribe" | "extract"): string {
	if (mode === "extract" && tools.has("add_entries") && !tools.has("write")) {
		return `Add the entries of this unit to ${file} with add_entries, check them, then call verify with final=true to commit it.`;
	}
	if (!tools.has("write")) return `Create ${file} with bash, check it, then call verify with final=true to commit it.`;
	return `Write ${file}, check it, then call verify with final=true to commit it.`;
}

/** First final=true with no entries after a draft of the same session had some. */
export function emptyDraftRefusal(tools: Tools, file: string, unitId: string, earlier: number): string {
	const drop = tools.has("add_entries")
		? " To drop wrong entries, use add_entries with remove (entry numbers) instead of emptying the file."
		: " Drop only the wrong entries instead of emptying the file.";
	const fix = tools.has("update_entry") ? ", e.g. with update_entry" : "";
	return `NOT COMMITTED: ${file} has no entries, but an earlier draft of ${unitId} in this session had ${earlier}. Check the source again; restore the entries if they belong to the requested type.${drop} Grounding warnings mean a verbatim field must copy the source exactly (fix that entry${fix}); they do not mean the unit has no content. If the unit really has none, call verify with final=true again to confirm.`;
}

/** First final=true with no entries for a page, or a chunk with real text. */
export function emptyContentRefusal(file: string, inputKind: "images" | "text"): string {
	return `NOT COMMITTED: ${file} has no entries, but the ${inputKind === "images" ? "page" : "chunk"} has content. Look at the source again for entries of the requested kind and add them. If it really has none, call verify with final=true again to confirm.`;
}

/** First final=true with the chunk-coverage warning. */
export function coverageRefusal(tools: Tools, file: string, warning: string): string {
	const how = tools.has("add_entries")
		? "with add_entries"
		: tools.has("edit")
			? `edit ${file}; you may append entries in several edits`
			: `rewrite ${file} with ${createWith(tools)}`;
	return `Not committed: ${warning}. Commit is final and the next unit follows. If entries are missing, add them (${how}) and verify again. If nothing is missing (the rest of the chunk is unrelated text or continues an entry of the previous chunk), keep the entries and call verify final=true again to confirm.`;
}

/** final=true while the unit's page or text is no longer in the conversation (view and read are mandatory). */
export function notInContext(inputKind: "images" | "text", unitId: string, tools?: Tools): string {
	if (inputKind === "images" && tools && !tools.has("view")) {
		return `the page ${unitId} is not in the current context; show the full page with python (pagetools.show(pagetools.page())), check the file, then commit`;
	}
	return inputKind === "images"
		? `the page ${unitId} is not in the current context; call view without box to show the full page, check the file, then commit`
		: `the text of ${unitId} is not in the current context; read source/${unitId}.txt (whole file), check the file, then commit`;
}

/** An inspection call after the soft cap. */
export function softCapRefusal(tools: Tools, unitId: string, cap: number): string {
	const remaining = [
		...fileTools(tools).filter((name) => name !== "bash"),
		"verify",
		...(tools.has("read") ? ["reading your own unit file"] : []),
	];
	return `The inspection budget for ${unitId} is used up (${cap} tool calls). Only ${listing(remaining)} remain: finish the file and commit it with verify final=true.`;
}

/** A unit file that is not UTF-8. */
export function notUtf8Error(tools: Tools, file: string): string {
	return `${file} is not valid UTF-8 (probably written by a script with another encoding); ${utf8Fix(tools)}`;
}

function utf8Fix(tools: Tools): string {
	if (tools.has("write"))
		return `rewrite it with write${tools.has("bash") ? ", or in bash with encoding='utf-8'" : ""}`;
	if (tools.has("bash")) return "rewrite it in bash with encoding='utf-8'";
	return "it cannot be repaired with the tools available";
}

/** add_entries or update_entry on a unit file that is not UTF-8. */
export function notUtf8Refusal(tools: Tools, file: string, tool: "add_entries" | "update_entry"): string {
	return `${file} is not valid UTF-8 (probably written by a script with another encoding); ${utf8Fix(tools)} before using ${tool}. Nothing was changed.`;
}

/**
 * Remove suggestions of disabled tools from the results of pi's built-in tools. pi's read tells the agent to use
 * bash (sed) for a line longer than its byte limit.
 */
export function sanitizeBuiltinResult(tools: Tools, text: string): string {
	if (tools.has("bash")) return text;
	return text.replace(
		/\[Line (\d+) is ([^,\]]+), exceeds ([^\]]+?) limit\. Use bash:[^\]]*\]/g,
		(_whole, line: string, size: string, limit: string) =>
			`[Line ${line} is ${size}, longer than the ${limit} that read can show, so it cannot be displayed; continue with offset=${Number(line) + 1}.]`,
	);
}

/** Pending add_entries rejections (none are listed without add_entries). */
export function rejectionList(
	tools: Tools,
	unitId: string,
	pending: Array<{ id: string; text: string; position?: number }>,
): string | undefined {
	if (pending.length === 0 || !tools.has("add_entries")) return undefined;
	const list = pending
		.map((item) => `${item.id}${item.position === undefined ? "" : ` (position ${item.position})`} ${item.text}`)
		.join("; ");
	return `Pending add_entries rejections for ${unitId}: ${list}. Resend each corrected with add_entries, resolves=["<id>"] and that position, or drop it with resolves alone.`;
}

/** Whether the agent can keep notes (notes.md needs a tool that writes files). */
export function canKeepNotes(tools: Tools): boolean {
	return tools.has("write") || tools.has("edit") || tools.has("bash");
}
