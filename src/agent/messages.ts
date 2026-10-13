import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { describePrepared, prepareImage } from "../inputs/images.ts";
import { boundaryPolicy } from "../schemas/registry.ts";
import { lastLines, readUtf8File, truncate } from "../util.ts";
import { formatIssue } from "../verify/issues.ts";
import { parseTranscriptionUnit } from "../verify/rules.ts";
import { canKeepNotes, closingInstruction, rejectionList } from "./notices.ts";
import { neighbor, readCommitted, type SessionRuntime } from "./runtime.ts";
import { chunkFile, isDone, type UnitRecord, unitFile } from "./state.ts";

export type MessageContent = Array<TextContent | ImageContent>;

export const NOTES_LIMIT = 6000;
const CONTEXT_LINES_BEFORE = 4;
const CONTEXT_LINES_AFTER = 10;
/** Stored issues of an earlier attempt listed with its draft (errors first). */
const MAX_DRAFT_ISSUES = 8;

/** Marker that starts every unit message; the extension uses it to find where the current unit begins. */
export function unitMarker(unit: UnitRecord): string {
	return `Current unit: ${unit.id}`;
}

export function unitLabel(runtime: SessionRuntime, unit: UnitRecord): string {
	const total = runtime.state.units.length;
	const position = runtime.batch.findIndex((candidate) => candidate.id === unit.id) + 1;
	const sessionPart = position > 0 ? `; unit ${position} of ${runtime.batch.length} in this session` : "";
	if (runtime.inputKind === "images") {
		return `${unit.id} (page ${unit.index} of ${total}${sessionPart})`;
	}
	const lines = runtime.sources.totalLines ? ` of ${runtime.sources.totalLines}` : "";
	return `${unit.id} (lines ${unit.startLine}-${unit.endLine}${lines}, chunk ${unit.index} of ${total}${sessionPart})`;
}

export function readNotes(runtime: SessionRuntime): string {
	const path = join(runtime.workDir, "notes.md");
	if (!existsSync(path)) return "";
	const notes = readUtf8File(path).text.trim();
	if (notes.length <= NOTES_LIMIT) return notes;
	// The newest notes are at the end; keep those, starting at a line boundary.
	const marker = `[Earlier notes cut: only the last part of notes.md (${notes.length.toLocaleString("en-US")} characters) is shown.]`;
	let tail = notes.slice(notes.length - (NOTES_LIMIT - marker.length - 1));
	const lineStart = tail.indexOf("\n");
	if (lineStart >= 0 && lineStart < tail.length - 1) tail = tail.slice(lineStart + 1);
	return `${marker}\n${tail}`;
}

/** End of the previous finished unit (from its committed copy), for continuity across units. */
export function previousTail(runtime: SessionRuntime, unit: UnitRecord): string | undefined {
	const previous = neighbor(runtime, unit, -1);
	if (!previous || !isDone(previous)) return undefined;
	const { content } = readCommitted(runtime, previous);
	if (content === undefined) return undefined;
	if (runtime.mode === "transcribe") {
		const parsed = parseTranscriptionUnit(content, runtime.schema);
		const body = parsed.body?.trim();
		return body ? `Last lines of ${previous.id}:\n${lastLines(body, 12)}` : undefined;
	}
	try {
		const data = JSON.parse(content) as { entries?: unknown[] };
		const entries = Array.isArray(data.entries) ? data.entries : [];
		if (entries.length === 0) return `${previous.id} has no entries.`;
		return `${previous.id} has ${entries.length} entries; the last one is:\n${truncate(JSON.stringify(entries[entries.length - 1]), 800)}`;
	} catch {
		return undefined;
	}
}

/**
 * Carry-over notes from earlier units. Pages can only be completed from the next page, so only the previous page's
 * note applies; text chunks may be completed up to two chunks ahead, so a note from two chunks back applies only
 * if its entry actually reaches this chunk.
 */
export function carryOverNote(runtime: SessionRuntime, unit: UnitRecord): string | undefined {
	const notes: string[] = [];
	const offsets = runtime.inputKind === "images" ? [1] : [2, 1];
	for (const offset of offsets) {
		const earlier = neighbor(runtime, unit, -offset);
		if (!earlier?.carryOver) continue;
		notes.push(
			offset === 1
				? `Carry-over from ${earlier.id}: an entry recorded there continues into this unit (${earlier.carryOver}). Skip the part of this unit that belongs to it.`
				: `Carry-over from ${earlier.id}: an entry recorded there continues into the following units (${earlier.carryOver}). Only if that entry reaches this unit, skip the part of this unit that belongs to it; otherwise ignore this note.`,
		);
	}
	return notes.length > 0 ? notes.join("\n") : undefined;
}

/** Note about a draft left by an earlier, interrupted or reviewed attempt at this unit. */
function draftNote(runtime: SessionRuntime, unit: UnitRecord): string | undefined {
	if (!existsSync(join(runtime.workDir, unitFile(runtime.mode, unit)))) return undefined;
	const why = unit.closedReason ? ` (it was closed for review earlier: ${unit.closedReason})` : "";
	const draft = `A draft from an earlier attempt exists in ${unitFile(runtime.mode, unit)}${why}. Check it against the source and improve it rather than starting over.`;
	const issues = [...(unit.issues ?? [])].sort(
		(a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1),
	);
	if (issues.length === 0) return draft;
	const listed = issues
		.slice(0, MAX_DRAFT_ISSUES)
		.map((issue) => `- ${truncate(formatIssue(issue), 300)}`)
		.join("\n");
	const more = issues.length > MAX_DRAFT_ISSUES ? `\n- ... and ${issues.length - MAX_DRAFT_ISSUES} more` : "";
	return `${draft} The last check of that attempt reported:\n${listed}${more}`;
}

/** Rejections of add_entries for this unit that are still open (they survive new sessions). */
export function rejectionNote(runtime: Pick<SessionRuntime, "tools">, unit: UnitRecord): string | undefined {
	return rejectionList(runtime.tools, unit.id, unit.rejections?.pending ?? []);
}

/** The content block that hands one unit to the agent. */
export async function unitContent(
	runtime: SessionRuntime,
	unit: UnitRecord,
	options: { withContextImages?: boolean; preface?: string } = {},
): Promise<MessageContent> {
	const content: MessageContent = [];
	const intro: string[] = [];
	if (options.preface) intro.push(options.preface);
	intro.push(`${unitMarker(unit)} ${unitLabel(runtime, unit).slice(unit.id.length).trim()}.`);
	const carry = carryOverNote(runtime, unit);
	if (carry) intro.push(carry);
	const draft = draftNote(runtime, unit);
	if (draft) intro.push(draft);
	const rejections = rejectionNote(runtime, unit);
	if (rejections) intro.push(rejections);
	if (options.withContextImages && runtime.contextImages.length > 0) {
		intro.push(
			`The next ${runtime.contextImages.length} image(s) are user-provided context, not pages of the document.`,
		);
	}
	content.push({ type: "text", text: intro.join("\n") });
	if (options.withContextImages) {
		for (const { label, image } of runtime.contextImages) {
			content.push({ type: "text", text: `Context image: ${label}` });
			content.push({ type: "image", data: image.data, mimeType: image.mimeType });
		}
	}
	if (runtime.inputKind === "images") {
		const { key, loader } = runtime.sources.image(unit);
		const image = await prepareImage(key, loader, { limits: runtime.imageProfile });
		runtime.pageImageBytes = image.data.length;
		content.push({
			type: "text",
			text: `${describePrepared(`Page ${unit.id}`, image, runtime.tools.has("view"))} This is the full page${runtime.tools.has("view") ? "; use view with box to zoom in" : ""}.`,
		});
		content.push({ type: "image", data: image.data, mimeType: image.mimeType });
	} else {
		runtime.sources.materialize(unit);
		const previous = neighbor(runtime, unit, -1);
		const next = neighbor(runtime, unit, 1);
		const parts: string[] = [];
		if (previous) {
			parts.push(
				`(Preceding context, end of ${previous.id}; already handled:)\n${lastLines(runtime.sources.text(previous), CONTEXT_LINES_BEFORE)}`,
			);
		}
		parts.push(
			`----- ${chunkFile(unit)} (lines ${unit.startLine}-${unit.endLine}) -----\n${runtime.sources.text(unit)}\n----- end of ${unit.id} -----`,
		);
		if (next) {
			const head = runtime.sources.text(next).split("\n").slice(0, CONTEXT_LINES_AFTER).join("\n");
			const fragments = runtime.mode === "extract" && boundaryPolicy(runtime.schema) === "fragments";
			parts.push(
				fragments
					? `(Following context, start of ${next.id}; it belongs to the next unit and is recorded there. An entry of this unit that continues there is recorded here with this chunk's part only, as a fragment:)\n${head}`
					: `(Following context, start of ${next.id}; it belongs to the next unit. If an entry of this unit continues there, read ${chunkFile(next)} to complete it:)\n${head}`,
			);
		}
		content.push({ type: "text", text: parts.join("\n\n") });
	}
	content.push({
		type: "text",
		text: closingInstruction(runtime.tools, unitFile(runtime.mode, unit), runtime.mode),
	});
	return content;
}

/** The session's units as a range ("p0001-p0020") when they are consecutive, otherwise as a list of ids. */
export function batchRange(runtime: Pick<SessionRuntime, "batch">): string {
	const { batch } = runtime;
	const first = batch[0];
	const last = batch[batch.length - 1];
	if (first.id === last.id) return first.id;
	const contiguous = batch.every((unit, i) => i === 0 || unit.index === batch[i - 1].index + 1);
	return contiguous ? `${first.id}-${last.id}` : batch.map((unit) => unit.id).join(", ");
}

function progressLine(runtime: SessionRuntime): string {
	const done = runtime.state.units.filter(isDone).length;
	return `Document progress: ${done} of ${runtime.state.units.length} units finished.`;
}

/** Text of the first message of a session (handoff from earlier sessions plus the first unit). */
export function sessionIntro(runtime: SessionRuntime): string {
	const parts = [
		`Session start. Document: ${runtime.documentLabel}. This session covers ${runtime.batch.length} unit(s): ${batchRange(runtime)}.`,
		progressLine(runtime),
	];
	const notes = readNotes(runtime);
	if (notes) parts.push(`Your notes so far (notes.md):\n${notes}`);
	else if (canKeepNotes(runtime.tools))
		parts.push("notes.md is empty; start it once you notice conventions worth keeping.");
	const tail = previousTail(runtime, runtime.batch[0]);
	if (tail) parts.push(tail);
	return parts.join("\n\n");
}

/** Deterministic summary that replaces the conversation when it is compacted. */
export function stateSummary(runtime: SessionRuntime, current: UnitRecord | undefined, inProgress: boolean): string {
	const committed = runtime.batch.filter((unit) => unit.status === "committed").map((unit) => unit.id);
	const review = runtime.batch.filter((unit) => unit.status === "needs_review").map((unit) => unit.id);
	const parts = [
		"[Mabillon] Earlier messages of this session were removed to save context. Current state:",
		`Document: ${runtime.documentLabel}. Session units: ${batchRange(runtime)}.`,
		`Committed in this session: ${committed.length > 0 ? committed.join(", ") : "none"}${review.length > 0 ? `; closed for review: ${review.join(", ")}` : ""}.`,
		progressLine(runtime),
	];
	const notes = readNotes(runtime);
	if (notes) parts.push(`Your notes (notes.md):\n${notes}`);
	if (current) {
		const tail = previousTail(runtime, current);
		if (tail) parts.push(tail);
		if (inProgress) {
			parts.push(
				`You were working on ${current.id}. Your draft, if any, is in ${unitFile(runtime.mode, current)}; the unit is shown again below.`,
			);
		}
		const rejections = rejectionNote(runtime, current);
		if (rejections) parts.push(rejections);
	}
	return parts.join("\n\n");
}
