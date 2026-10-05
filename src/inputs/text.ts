import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { strFromU8, Unzip, UnzipInflate, unzipSync } from "fflate";
import mammoth from "mammoth";
import TurndownService from "turndown";
import { decodeText } from "../util.ts";

function htmlToMarkdown(html: string): string {
	const service = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "*",
	});
	service.remove(["script", "style", "head", "title", "noscript"]);
	// The text is evidence: no Markdown escaping ("12. Take" must not become "12\\. Take").
	service.escape = (text: string) => text;
	// Superscripts and subscripts (footnote references, abbreviations such as "Mr", units) stay marked.
	service.addRule("supSub", {
		filter: ["sup", "sub"],
		replacement: (content, node) => {
			const tag = node.nodeName.toLowerCase();
			return content ? `<${tag}>${content}</${tag}>` : "";
		},
	});
	// Tables as pipe tables, one row per line, keeping empty cells so values stay in their columns.
	service.addRule("tables", {
		filter: "table",
		replacement: (_content, node) => `\n\n${tableToMarkdown(node as unknown as DomElement)}\n\n`,
	});
	// Embedded images (data: URIs, e.g. from DOCX) would put megabytes of base64 into the text.
	service.addRule("embeddedImages", {
		filter: (node) => node.nodeName === "IMG",
		replacement: (_content, node) => {
			const element = node as unknown as { getAttribute(name: string): string | null };
			const src = element.getAttribute("src") ?? "";
			const alt = (element.getAttribute("alt") ?? "").trim();
			if (!src || src.startsWith("data:")) return alt ? `![Image: ${alt}]` : "![Image]";
			return `![${alt}](${src})`;
		},
	});
	return service.turndown(html);
}

interface DomElement {
	nodeName: string;
	nodeType: number;
	nodeValue: string | null;
	textContent: string | null;
	children: ArrayLike<DomElement>;
	childNodes: ArrayLike<DomElement>;
	getAttribute(name: string): string | null;
}

const BLOCK_ELEMENTS = new Set([
	"P",
	"DIV",
	"LI",
	"UL",
	"OL",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"BLOCKQUOTE",
	"TABLE",
]);

/** Text of a table cell: lines (paragraphs, <br>) joined with <br>, so words of separate lines do not run together. */
function cellText(cell: DomElement): string {
	let text = "";
	const walk = (node: DomElement) => {
		if (node.nodeType === 3) {
			text += node.nodeValue ?? "";
			return;
		}
		if (node.nodeName === "BR") {
			text += "\n";
			return;
		}
		const block = BLOCK_ELEMENTS.has(node.nodeName);
		if (block) text += "\n";
		if (node.nodeName === "SUP" || node.nodeName === "SUB") {
			const tag = node.nodeName.toLowerCase();
			text += `<${tag}>${(node.textContent ?? "").trim()}</${tag}>`;
		} else {
			for (const child of Array.from(node.childNodes)) walk(child);
		}
		if (block) text += "\n";
	};
	for (const child of Array.from(cell.childNodes)) walk(child);
	return text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line !== "")
		.join("<br>")
		.replace(/\|/g, "\\|");
}

const MAX_CELL_SPAN = 50;

function cellSpan(cell: DomElement, attribute: string): number {
	const span = Number.parseInt(cell.getAttribute(attribute) ?? "1", 10);
	return Number.isFinite(span) && span >= 1 ? Math.min(span, MAX_CELL_SPAN) : 1;
}

function tableToMarkdown(table: DomElement): string {
	// Grid of cell texts; positions covered by a rowspan or colspan from another cell hold "" so the values of later
	// cells stay in their columns.
	const grid: string[][] = [];
	let rowCount = 0;
	const collect = (element: DomElement) => {
		for (const child of Array.from(element.children)) {
			const name = child.nodeName;
			if (name === "TR") {
				const row = rowCount++;
				grid[row] ??= [];
				let column = 0;
				for (const cell of Array.from(child.children)) {
					if (cell.nodeName !== "TD" && cell.nodeName !== "TH") continue;
					while (grid[row][column] !== undefined) column++;
					const colspan = cellSpan(cell, "colspan");
					const rowspan = cellSpan(cell, "rowspan");
					for (let r = row; r < row + rowspan; r++) {
						grid[r] ??= [];
						for (let c = column; c < column + colspan; c++) grid[r][c] = "";
					}
					grid[row][column] = cellText(cell);
					column += colspan;
				}
			} else if (name === "THEAD" || name === "TBODY" || name === "TFOOT") {
				collect(child);
			}
		}
	};
	collect(table);
	// Rowspans reaching past the last row do not add rows.
	const rows = grid.slice(0, rowCount).map((row) => Array.from(row, (cell) => cell ?? ""));
	const caption = Array.from(table.children).find((child) => child.nodeName === "CAPTION");
	const captionText = caption ? (caption.textContent ?? "").replace(/\s+/g, " ").trim() : "";
	if (rows.length === 0) return captionText;
	const width = Math.max(...rows.map((row) => row.length), 1);
	const line = (cells: string[]) =>
		`| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`.replace(/ {2,}\|/g, " |");
	const markdownTable = [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
	return captionText ? `${captionText}\n\n${markdownTable}` : markdownTable;
}

function resolveZipPath(base: string, href: string): string {
	const parts = (base ? `${base}/${href}` : href).split("/");
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else {
			try {
				out.push(decodeURIComponent(part));
			} catch {
				out.push(part);
			}
		}
	}
	return out.join("/");
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode the XML character references and predefined entities of an attribute value. */
function decodeXmlEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole, ref: string) => {
		if (ref[0] === "#") {
			const code =
				ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return XML_ENTITIES[ref.toLowerCase()] ?? whole;
	});
}

function attr(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
	const value = match ? (match[2] ?? match[3]) : undefined;
	return value === undefined ? undefined : decodeXmlEntities(value);
}

const MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;

/** Unpack only the wanted entries of a ZIP container, refusing entries that would inflate beyond sane sizes. */
function unzipEntries(path: string, data: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
	let total = 0;
	return unzipSync(data, {
		filter: (file) => {
			if (!wanted(file.name)) return false;
			total += file.originalSize;
			if (file.originalSize > MAX_ZIP_ENTRY_BYTES || total > MAX_ZIP_TOTAL_BYTES) {
				throw new Error(`${path}: ${file.name} is too large when unpacked (possible ZIP bomb)`);
			}
			return true;
		},
	});
}

/**
 * Reject ZIP containers (DOCX) that inflate beyond sane sizes before a parser unpacks them. The sizes declared in the
 * archive can lie, so the entries are inflated (streaming, nothing kept) and the actual bytes counted.
 */
function checkZipSize(path: string, data: Uint8Array): void {
	let total = 0;
	const tooLarge = (name: string) => new Error(`${path}: ${name} is too large when unpacked (possible ZIP bomb)`);
	const unzip = new Unzip((file) => {
		let size = 0;
		file.ondata = (error, chunk) => {
			if (error) throw error;
			size += chunk.length;
			total += chunk.length;
			if (size > MAX_ZIP_ENTRY_BYTES || total > MAX_ZIP_TOTAL_BYTES) throw tooLarge(file.name);
		};
		file.start();
	});
	unzip.register(UnzipInflate);
	unzip.push(data, true);
}

/** Convert an EPUB to Markdown, chapter by chapter in spine order. Only the package and spine files are unpacked. */
function epubToMarkdown(path: string): string {
	const data = new Uint8Array(readFileSync(path));
	const container = unzipEntries(path, data, (name) => name === "META-INF/container.xml")["META-INF/container.xml"];
	if (!container) throw new Error(`${path}: not an EPUB (META-INF/container.xml missing)`);
	const rootTag = /<(?:[\w-]+:)?rootfile\b[^>]*>/i.exec(strFromU8(container))?.[0];
	const opfPath = rootTag ? attr(rootTag, "full-path") : undefined;
	const opfData = opfPath ? unzipEntries(path, data, (name) => name === opfPath)[opfPath] : undefined;
	if (!opfPath || !opfData) throw new Error(`${path}: EPUB package document not found`);
	const opf = strFromU8(opfData);
	const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/")) : "";
	const manifest = new Map<string, string>();
	for (const tag of opf.match(/<(?:[\w-]+:)?item\b[^>]*>/gi) ?? []) {
		const id = attr(tag, "id");
		const href = attr(tag, "href");
		// The href is a URL (percent-encoded, decoded per path segment) without the fragment part.
		if (id && href) manifest.set(id, resolveZipPath(opfDir, href.replace(/#.*$/, "")));
	}
	// A spine entry that cannot be resolved would silently drop a chapter; it is a document error instead.
	const spine = (opf.match(/<(?:[\w-]+:)?itemref\b[^>]*>/gi) ?? []).map((tag) => {
		const idref = attr(tag, "idref");
		const file = idref ? manifest.get(idref) : undefined;
		if (!file) throw new Error(`${path}: the EPUB spine refers to "${idref ?? ""}", which is not in the manifest`);
		return file;
	});
	const wanted = new Set(spine);
	const files = unzipEntries(path, data, (name) => wanted.has(name));
	const chapters: string[] = [];
	for (const file of spine) {
		const chapter = files[file];
		if (!chapter) throw new Error(`${path}: the EPUB chapter ${file} named in the spine is missing from the archive`);
		const markdown = htmlToMarkdown(strFromU8(chapter)).trim();
		if (markdown) chapters.push(markdown);
	}
	return chapters.join("\n\n");
}

const MAX_DOCX_MESSAGES = 5;

/** Load a text-like document as plain text or Markdown. `warning` reports encoding and DOCX conversion problems. */
export async function loadTextDocument(path: string): Promise<{ text: string; warning?: string }> {
	const ext = extname(path).toLowerCase();
	let text: string;
	let warning: string | undefined;
	if (ext === ".docx") {
		const data = readFileSync(path);
		checkZipSize(path, new Uint8Array(data));
		const { value, messages } = await mammoth.convertToHtml({ buffer: data });
		text = htmlToMarkdown(value);
		const distinct = [...new Set(messages.map((message) => `${message.type}: ${message.message}`))];
		if (distinct.length > 0) {
			const more = distinct.length > MAX_DOCX_MESSAGES ? `; and ${distinct.length - MAX_DOCX_MESSAGES} more` : "";
			warning = `DOCX conversion: ${distinct.slice(0, MAX_DOCX_MESSAGES).join("; ")}${more}`;
		}
	} else if (ext === ".epub") {
		text = epubToMarkdown(path);
	} else if (ext === ".html" || ext === ".htm" || ext === ".xhtml") {
		const decoded = decodeText(readFileSync(path));
		warning = decoded.warning;
		text = htmlToMarkdown(decoded.text);
	} else {
		const decoded = decodeText(readFileSync(path));
		warning = decoded.warning;
		text = decoded.text;
	}
	return { text: text.replace(/\r\n?/g, "\n"), warning };
}

export interface TextChunk {
	/** 1-based chunk index. */
	index: number;
	/** 1-based first and last line of the chunk within the converted document text. */
	startLine: number;
	endLine: number;
	text: string;
}

const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s/;
/** Page separators of ChronoAgent and ChronoTranscriber transcripts. */
const PAGE_SEPARATOR = /^<!-- page \d+|^<!--\s*page\b|^\[?page \d+\]?$/i;
const PAGE_NUMBER = /^<page_number>/;
const SENTENCE_END = /[.!?:;)\]»"'”’]\s*$/;

/**
 * How good a place it is to start a new chunk at line `index`: a page separator of a transcript is best, then a
 * heading or a title after a blank line, then any paragraph break, then a sentence end; the first line of a page
 * (right after its separator) and a line that starts in lower case are poor places to cut.
 */
export function boundaryScore(lines: string[], index: number): number {
	const current = lines[index] ?? "";
	const previous = lines[index - 1] ?? "";
	const trimmed = current.trim();
	if (trimmed === "") return 0;
	// A page separator is the best place to cut; directly after one (its page) is the worst.
	if (PAGE_SEPARATOR.test(trimmed)) return 7;
	const lastText = previous.trim() !== "" ? previous : (lines[index - 2] ?? "");
	if (PAGE_SEPARATOR.test(lastText.trim())) return -2;
	if (MARKDOWN_HEADING.test(current)) return 6;
	const afterBlank = previous.trim() === "";
	const titleLike = trimmed.length <= 90 && /^[\p{Lu}\d§¶*]/u.test(trimmed) && !/[,;]$/.test(trimmed);
	if (afterBlank && titleLike) return 5;
	if (PAGE_NUMBER.test(trimmed)) return 3;
	if (afterBlank) return 4;
	if (/^\p{Ll}/u.test(trimmed)) return -1;
	if (SENTENCE_END.test(previous)) return 1;
	return 0;
}

interface Segment {
	text: string;
	/** 1-based source line. */
	line: number;
}

/** Split a line longer than `maxChars` at sentence ends or spaces; every piece keeps the source line number. */
function splitLongLine(text: string, line: number, maxChars: number): Segment[] {
	if (text.length <= maxChars) return [{ text, line }];
	const pieces: Segment[] = [];
	let rest = text;
	while (rest.length > maxChars) {
		const window = rest.slice(0, maxChars);
		let cut = -1;
		const sentence = /[.!?;:]["'”’)\]]?\s/g;
		for (let match = sentence.exec(window); match; match = sentence.exec(window)) {
			if (match.index > maxChars * 0.5) cut = match.index + match[0].length;
		}
		if (cut < 0) {
			const space = window.lastIndexOf(" ");
			cut = space > maxChars * 0.5 ? space + 1 : maxChars;
			// A hard cut must not separate the two halves of a surrogate pair.
			const code = rest.charCodeAt(cut - 1);
			if (cut === maxChars && code >= 0xd800 && code <= 0xdbff) cut--;
		}
		pieces.push({ text: rest.slice(0, cut).replace(/\s+$/, ""), line });
		rest = rest.slice(cut);
	}
	if (rest.length > 0) pieces.push({ text: rest, line });
	return pieces;
}

/**
 * Chunk text into units of roughly `chunkTokens` tokens (estimated as 4 characters per token), cutting at the
 * best semantic boundary in the last 40% of each chunk. Chunk line numbers refer to `text`; a line longer than a
 * chunk is split at sentence ends or spaces, and its pieces keep that line's number.
 */
export function chunkText(text: string, chunkTokens: number): { chunks: TextChunk[]; lines: string[] } {
	const budget = Math.max(400, Math.round(chunkTokens * 4));
	const minSize = Math.round(budget * 0.6);
	const trimmed = text.replace(/\s+$/, "");
	const lines = trimmed.split("\n");
	if (trimmed.trim() === "") return { chunks: [], lines };
	const segments = lines.flatMap((line, index) => splitLongLine(line, index + 1, budget));
	const texts = segments.map((segment) => segment.text);
	const chunks: TextChunk[] = [];
	const push = (start: number, end: number) =>
		chunks.push({
			index: chunks.length + 1,
			startLine: segments[start].line,
			endLine: segments[end].line,
			text: texts.slice(start, end + 1).join("\n"),
		});
	let start = 0;
	while (start < segments.length) {
		let size = 0;
		let next = start;
		while (next < segments.length && (next === start || size + texts[next].length + 1 <= budget)) {
			size += texts[next].length + 1;
			next++;
		}
		if (next >= segments.length) {
			push(start, segments.length - 1);
			break;
		}
		// `next` is the first segment that does not fit. Look back for the best place to cut.
		let best = next;
		let bestScore = boundaryScore(texts, next);
		let prefix = size;
		for (let cut = next - 1; cut > start; cut--) {
			prefix -= texts[cut].length + 1;
			if (prefix < minSize) break;
			const score = boundaryScore(texts, cut);
			if (score > bestScore) {
				best = cut;
				bestScore = score;
			}
		}
		push(start, best - 1);
		start = best;
	}
	return { chunks, lines };
}

/** Gaps, overlaps and missing lines in a set of line ranges (each would drop or duplicate source text). */
export function lineRangeIssues(chunks: TextChunk[], totalLines: number): string[] {
	const issues: string[] = [];
	const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);
	let next = 1;
	for (const chunk of sorted) {
		if (chunk.startLine > next) issues.push(`lines ${next}-${chunk.startLine - 1} are in no range`);
		if (chunk.startLine < next)
			issues.push(`lines ${chunk.startLine}-${Math.min(next - 1, chunk.endLine)} are in more than one range`);
		next = Math.max(next, chunk.endLine + 1);
	}
	if (next <= totalLines) issues.push(`lines ${next}-${totalLines} are in no range`);
	return issues;
}

/**
 * Chunks from explicit 1-based inclusive line ranges, e.g. a ChronoMiner `<stem>_line_ranges.txt`
 * ("(1, 120)" per line). Ranges outside the text are clipped; invalid lines are ignored. Ranges that start before
 * the end of the previous range (out of order or overlapping) are rejected with an error.
 */
export function chunksFromLineRanges(lines: string[], rangesText: string): TextChunk[] {
	const chunks: TextChunk[] = [];
	for (const raw of rangesText.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const match = /^\s*\(?\s*(\d+)\s*,\s*(\d+)\s*\)?\s*$/.exec(raw);
		if (!match) continue;
		const start = Number.parseInt(match[1], 10);
		const end = Math.min(Number.parseInt(match[2], 10), lines.length);
		if (start < 1 || end < start) continue;
		const previous = chunks[chunks.length - 1];
		if (previous && start <= previous.endLine) {
			const problem = start < previous.startLine ? "is out of order" : "overlaps";
			throw new Error(
				`_line_ranges.txt: range (${match[1]}, ${match[2]}) ${problem} with the previous range (${previous.startLine}, ${previous.endLine}); ranges must be in ascending order without overlaps`,
			);
		}
		chunks.push({
			index: chunks.length + 1,
			startLine: start,
			endLine: end,
			text: lines.slice(start - 1, end).join("\n"),
		});
	}
	return chunks;
}
