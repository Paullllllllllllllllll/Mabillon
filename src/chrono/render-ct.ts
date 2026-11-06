import { PY_SPACE, pyStrip } from "./py.ts";
import type { Connection } from "./sqlite.ts";

/**
 * The `.txt` and `.md` views of a ChronoTranscriber document, ported from CT `output/render.py` and
 * `llm/response_parsing.py`: done and failed units in order, each as one page line; txt joins them with a newline,
 * md with a blank line; every file ends with exactly one newline.
 */

export const TEXT_FORMATS = ["txt", "md"] as const;
export type TextFormat = (typeof TEXT_FORMATS)[number];
export const FAILED_PLACEHOLDER = "[transcription error]";
export const NO_TEXT_PLACEHOLDER = "[No transcribable text]";
export const NOT_POSSIBLE_PLACEHOLDER = "[Transcription not possible]";

// Python's `.` excludes only "\n"; `\s` is Unicode whitespace; the patterns match from the start of the text.
const placeholder = (words: string) =>
	new RegExp(`^(?:[^\\[]+?:${PY_SPACE}*)?\\[${PY_SPACE}*${words}[^\\n]*\\]$`, "iu");
const ERROR = placeholder(`transcription${PY_SPACE}+error`);
const NO_TEXT = placeholder(`No${PY_SPACE}+transcribable${PY_SPACE}+text`);
const NOT_POSSIBLE = placeholder(`Transcription${PY_SPACE}+not${PY_SPACE}+possible`);

export type Cause = "api_error" | "no_text" | "not_possible" | "ok";

/** `detect_transcription_cause`. */
export function detectCause(text: string): Cause {
	const s = pyStrip(text ?? "");
	if (!s.endsWith("]")) return "ok";
	if (ERROR.test(s)) return "api_error";
	if (NO_TEXT.test(s)) return "no_text";
	if (NOT_POSSIBLE.test(s)) return "not_possible";
	return "ok";
}

/** `format_page_line`: placeholders get the page's header, other text is written stripped and bare. */
export function formatPageLine(text: string, pageNumber: number | null, imageName: string | null): string {
	const safe = pyStrip(imageName ?? "");
	let header: string;
	if (safe) header = `${safe}:`;
	else if (pageNumber !== null && pageNumber > 0) header = `Page ${pageNumber}:`;
	else header = "[unknown image]:";
	const s = pyStrip(text ?? "");
	return detectCause(s) === "ok" ? s : `${header} ${s}`;
}

export interface RenderUnit {
	kind: string;
	idx: number;
	status: string;
	label: string | null;
	content: string | null;
}

/** The text of a document's units (status != pending, ordered by idx, kind) in one text format. */
export function renderUnits(units: RenderUnit[], documentKind: string | null, format: TextFormat): string {
	const lines: string[] = [];
	const texts: string[] = [];
	let textLine: number | undefined;
	for (const unit of units) {
		const text = unit.content ?? (unit.status === "failed" ? FAILED_PLACEHOLDER : "");
		if (unit.kind === "text") {
			if (textLine === undefined) {
				textLine = lines.length;
				lines.push("");
			}
			texts.push(text);
			continue;
		}
		lines.push(formatPageLine(text, unit.idx + 1, unit.label));
	}
	if (textLine !== undefined) {
		const block =
			documentKind === "epub" || documentKind === "mobi"
				? texts.filter((text) => text).join("\n\n")
				: texts.join("");
		lines[textLine] = formatPageLine(block, null, null);
	}
	const body = lines.join(format === "txt" ? "\n" : "\n\n");
	return `${body.replace(/\n+$/, "")}\n`;
}

/** The rendering of a stored document, read through `connection`. */
export function renderDocument(connection: Connection, docId: number, format: TextFormat): string {
	const kind = connection.get("SELECT kind FROM documents WHERE doc_id = ?", docId)?.kind;
	const units = connection.all(
		"SELECT kind, idx, status, label, content FROM units WHERE doc_id = ? AND status != 'pending' ORDER BY idx, kind",
		docId,
	) as unknown as RenderUnit[];
	return renderUnits(units, kind === undefined || kind === null ? null : String(kind), format);
}

/** Number of units a rendering shows (done or failed). */
export function renderedUnitCount(connection: Connection, docId: number, kind?: string): number {
	const row =
		kind === undefined
			? connection.get("SELECT count(*) AS n FROM units WHERE doc_id = ? AND status != 'pending'", docId)
			: connection.get(
					"SELECT count(*) AS n FROM units WHERE doc_id = ? AND kind = ? AND status != 'pending'",
					docId,
					kind,
				);
	return Number(row?.n ?? 0);
}
