import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { batchRange, carryOverNote } from "../src/agent/messages.ts";
import { uncertaintyInstruction } from "../src/agent/prompts.ts";
import type { SessionRuntime } from "../src/agent/runtime.ts";
import { sha256Text, type UnitRecord } from "../src/agent/state.ts";
import { cli, parseArgs } from "../src/cli.ts";
import { coerceConfigValue, mergeConfig } from "../src/config.ts";
import { resolveContext } from "../src/context.ts";
import { assignStems, discoverDocuments, type SourceDocument } from "../src/inputs/discover.ts";
import { type Enhancement, gridLabels, prepareImage } from "../src/inputs/images.ts";
import { boundaryScore, chunksFromLineRanges, chunkText, loadTextDocument } from "../src/inputs/text.ts";
import { loadSchemaFile, resolveSchema } from "../src/schemas/registry.ts";
import { collectStatus } from "../src/status.ts";
import { naturalCompare, parseSelection } from "../src/util.ts";
import { buildGroundingSource, groundingCoverage, hasTailLoop } from "../src/verify/rules.ts";
import { verifyTranscriptionPage, verifyUnitContent } from "../src/verify/verify.ts";
import { CATALOGUE_TRANSCRIPTION_SCHEMA, RECIPES_SCHEMA, tempDir } from "./helpers.ts";

const transcription = resolveSchema(undefined, "transcribe", []);
const recipes = resolveSchema(RECIPES_SCHEMA, "extract", []);

function unit(front: string, body: string): string {
	return `---\n${front}\n---\n${body}`;
}

describe("transcription unit verification", () => {
	it("accepts a well-formed page", () => {
		const result = verifyUnitContent({
			schema: transcription,
			content: unit(
				"image_analysis: |\n  One column.\nno_transcribable_text: false\ntranscription_not_possible: false",
				"<page_number>3</page_number>\nTo make a Tart.[^1]\n\n[^1]: Note.",
			),
		});
		expect(result.errors).toBe(0);
		expect(result.warnings).toBe(0);
		expect((result.data as Record<string, unknown>).transcription).toContain("To make a Tart.");
	});

	it("reports missing front matter, flag conflicts, markers, and schema violations", () => {
		expect(verifyUnitContent({ schema: transcription, content: "just text" }).errors).toBe(1);
		const flagged = verifyUnitContent({
			schema: transcription,
			content: unit("image_analysis: blank\nno_transcribable_text: true\ntranscription_not_possible: false", "text"),
		});
		expect(flagged.issues.map((issue) => issue.message).join("\n")).toMatch(/must have an empty body/);
		const markers = verifyUnitContent({
			schema: transcription,
			content: unit(
				"image_analysis: x\nno_transcribable_text: false\ntranscription_not_possible: false",
				"<page_number>4\n<unclear>word\n<gap>",
			),
		});
		const messages = markers.issues.map((issue) => issue.message).join("\n");
		expect(messages).toMatch(/unbalanced <page_number>/);
		expect(messages).toMatch(/unbalanced <unclear>/);
		expect(messages).toMatch(/self-closing <gap\/>/);
		const schema = verifyUnitContent({
			schema: transcription,
			content: unit("image_analysis: x\nno_transcribable_text: no\nextra: 1", "text"),
		});
		expect(schema.issues.some((issue) => issue.layer === "schema")).toBe(true);
	});

	it("treats an empty body as null for nullable body fields", () => {
		const result = verifyUnitContent({
			schema: transcription,
			content: unit(
				"image_analysis: blank page\nno_transcribable_text: true\ntranscription_not_possible: false",
				"",
			),
		});
		expect(result.errors).toBe(0);
		expect((result.data as Record<string, unknown>).transcription).toBeNull();
	});

	it("accepts the tags a catalogue schema documents", () => {
		const catalogue = resolveSchema(CATALOGUE_TRANSCRIPTION_SCHEMA, "transcribe", []);
		const body = [
			"<lot>Lot 17.</lot>",
			"*Le Cuisinier françois.* Paris, 1651. <price>3 fr.</price>",
			'<table><tr><th>Year</th><th>Copies</th></tr><tr><td rowspan="2">1651</td><td>3</td></tr></table>',
		].join("\n");
		const result = verifyUnitContent({
			schema: catalogue,
			content: unit(
				"image_analysis: two columns\nno_transcribable_text: false\ntranscription_not_possible: false",
				body,
			),
		});
		expect(result.issues).toEqual([]);
		const other = verifyUnitContent({
			schema: transcription,
			content: unit("image_analysis: x\nno_transcribable_text: false\ntranscription_not_possible: false", body),
		});
		expect(other.issues.map((issue) => issue.message).join("\n")).toMatch(/unexpected tags: <lot>/);
	});

	it("applies the unit checks to exported pages", () => {
		const page = verifyTranscriptionPage(transcription, {
			image_analysis: "blank",
			transcription: "Some text <invoke name='x'>",
			no_transcribable_text: true,
			transcription_not_possible: false,
		});
		const messages = page.issues.map((issue) => `${issue.layer} ${issue.message}`).join("\n");
		expect(messages).toMatch(/rules a page flagged no_transcribable_text .* must have an empty body/);
		expect(messages).toMatch(/quality contains tool-call markup/);
		expect(messages).toMatch(/unexpected tags: <invoke>/);
	});
});

describe("extraction unit verification", () => {
	it("reports JSON syntax errors with a location", () => {
		const result = verifyUnitContent({ schema: recipes, content: '{\n  "entries": [,]\n}' });
		expect(result.issues[0].layer).toBe("parse");
		expect(result.issues[0].message).toMatch(/line 2/);
	});

	it("checks the envelope rules and prompt bleed", () => {
		const result = verifyUnitContent({
			schema: recipes,
			content: JSON.stringify({
				contains_no_content_of_requested_type: true,
				entries: [{ note: '"additionalProperties"' }],
			}),
		});
		const messages = result.issues.map((issue) => `${issue.layer} ${issue.message}`).join("\n");
		expect(messages).toMatch(/rules is true but 1 entries are present/);
		expect(messages).toMatch(/quality contains schema or field names/);
	});
});

describe("grounding", () => {
	it("tolerates long s, ligatures and hyphenation but not normalization", () => {
		const source = buildGroundingSource(
			"Take ſpinage and parſ-\nley, and boyle them in fair water with a little ſalt.",
		);
		expect(groundingCoverage("Take spinage and parsley, and boyle them in fair water", source)).toBe(1);
		expect(groundingCoverage("Take spinach and parsley and boil them in fresh water", source)).toBeLessThan(0.5);
	});
});

describe("loop detection", () => {
	it("flags a repeated tail", () => {
		expect(hasTailLoop(`Start of the page. ${"and then the sugar, ".repeat(6)}`)).toBe(true);
		expect(hasTailLoop("An ordinary paragraph of historical prose without repetition at the end.")).toBe(false);
	});
});

describe("text chunking", () => {
	it("chunks on line boundaries, keeps source line numbers, and covers every line", () => {
		const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n");
		const { chunks, lines } = chunkText(text, 200);
		expect(lines).toHaveLength(100);
		expect(chunks.length).toBeGreaterThan(3);
		expect(chunks[0].startLine).toBe(1);
		for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
		expect(chunks[chunks.length - 1].endLine).toBe(100);
		expect(chunks.map((chunk) => chunk.text).join("\n")).toBe(text);
	});

	it("prefers headings and titles after blank lines as chunk starts", () => {
		const recipe = (n: number) =>
			[
				`To make a Tart of Hearbs ${n}.`,
				...Array.from({ length: 6 }, () => "Take ſpinage and parſley and boyle them tender, then ſeaſon them;"),
			].join("\n");
		const text = Array.from({ length: 8 }, (_, i) => recipe(i + 1)).join("\n\n");
		const { chunks } = chunkText(text, 300);
		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) expect(chunk.text.startsWith("To make a Tart")).toBe(true);
		const withHeading = `${"Plain prose line of moderate length.\n".repeat(20)}# Chapter II\n${"More prose follows here.\n".repeat(20)}`;
		const headed = chunkText(withHeading, 200);
		expect(headed.chunks.some((chunk) => chunk.text.startsWith("# Chapter II"))).toBe(true);
	});

	it("does not cut before a line that continues a sentence when a better cut exists", () => {
		expect(boundaryScore(["The ſugar", "and the ſpice"], 1)).toBeLessThan(0);
		expect(boundaryScore(["", "To make Pancakes."], 1)).toBeGreaterThan(boundaryScore(["", "and then"], 1));
	});

	it("reads ChronoMiner line ranges", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
		const chunks = chunksFromLineRanges(lines, "\uFEFF(1, 4)\n(5,8)\ngarbage\n(9, 50)\n(7, 3)\n");
		expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
			[1, 4],
			[5, 8],
			[9, 10],
		]);
		expect(chunks[1].text).toBe("l5\nl6\nl7\nl8");
	});
});

describe("selection", () => {
	it("parses unit ranges", () => {
		const selected = parseSelection("1-3, 7, 10-");
		expect([1, 2, 3, 4, 7, 9, 10, 99].filter(selected)).toEqual([1, 2, 3, 7, 10, 99]);
		expect(() => parseSelection("a-b")).toThrow();
	});
});

describe("discovery and context", () => {
	it("finds documents and context files", () => {
		const root = tempDir();
		const book = join(root, "book");
		mkdirSync(book);
		writeFileSync(join(book, "page2.png"), "");
		writeFileSync(join(book, "page10.png"), "");
		writeFileSync(join(book, "context-hand.png"), "");
		writeFileSync(join(root, "notes.pdf"), "");
		writeFileSync(join(root, "recipes.md"), "To make a Tart");
		writeFileSync(join(root, "context.md"), "Corpus: English cookery books.");
		writeFileSync(join(root, "book.context.md"), "This book is printed in roman type.");
		const transcribe = discoverDocuments([root], "transcribe");
		expect(transcribe.documents.map((doc) => doc.stem).sort()).toEqual(["book", "notes"]);
		expect(transcribe.skipped.some((skip) => skip.path.endsWith("recipes.md"))).toBe(true);
		const imageDoc = transcribe.documents.find((doc) => doc.stem === "book")!;
		// The pages are ChronoTranscriber's page list of the folder: every image in it, in natural order.
		expect(imageDoc.images?.map((path) => basename(path))).toEqual(["context-hand.png", "page2.png", "page10.png"]);
		const extract = discoverDocuments([root], "extract");
		expect(extract.documents.map((doc) => doc.kind).sort()).toEqual(["images", "pdf", "text"]);
		// Context comes from beside the folder, with ChronoTranscriber's sidecar as the most specific one.
		writeFileSync(join(root, "book_transcr_context.txt"), "Printed in Basel.");
		writeFileSync(join(root, "book_extract_context.txt"), "Recipes only.");
		const context = resolveContext(imageDoc, mergeConfig(), "transcribe");
		expect(context.texts.map((text) => text.content)).toEqual([
			"Corpus: English cookery books.",
			"This book is printed in roman type.",
			"Printed in Basel.",
		]);
		expect(context.images).toEqual([]);
		expect(resolveContext(imageDoc, mergeConfig(), "extract").texts.map((text) => text.content)).toContain(
			"Recipes only.",
		);
		// The tools' sidecars are never documents.
		expect(
			discoverDocuments([root], "extract")
				.documents.map((doc) => doc.kind)
				.sort(),
		).toEqual(["images", "pdf", "text"]);
	});

	it("gives every document of an output folder a distinct stem, even against suffixed names", () => {
		const doc = (path: string, stem: string): SourceDocument => ({ stem, kind: "text", path: join("/in", path) });
		const documents = [
			doc("a/book.txt", "book"),
			doc("b/book.txt", "book"),
			doc("c/a_book.txt", "a_book"),
			doc("d/a_book_2.txt", "a_book_2"),
		];
		assignStems(documents, () => "out");
		const stems = documents.map((document) => document.stem.toLowerCase());
		expect(new Set(stems).size).toBe(stems.length);
		expect(documents.map((document) => document.stem)).toEqual(["a_book", "b_book", "a_book_3", "a_book_2"]);
		const cased = [doc("x/Book.txt", "Book"), doc("y/BOOK_2.txt", "BOOK_2"), doc("x/book.md", "book")];
		assignStems(cased, () => "out");
		expect(new Set(cased.map((document) => document.stem.toLowerCase())).size).toBe(3);
	});
});

describe("natural sort", () => {
	it("orders numbers naturally and breaks ties deterministically by case and accents", () => {
		expect(naturalCompare("page2", "page10")).toBeLessThan(0);
		for (const [a, b] of [
			["a", "A"],
			["e", "é"],
			["p01", "p1"],
		]) {
			expect(naturalCompare(a, b)).not.toBe(0);
			expect(Math.sign(naturalCompare(a, b))).toBe(-Math.sign(naturalCompare(b, a)));
		}
		const names = ["B", "a", "é", "A", "b", "e", "p1", "p01"];
		expect([...names].sort(naturalCompare)).toEqual([...names].reverse().sort(naturalCompare));
	});
});

describe("table conversion", () => {
	it("keeps the columns of the next row under a rowspan", async () => {
		const path = join(tempDir(), "table.html");
		writeFileSync(
			path,
			"<table><tr><th>Item</th><th>Price</th><th>Unit</th></tr>" +
				'<tr><td rowspan="2">Wheat</td><td>12</td><td>bushel</td></tr>' +
				"<tr><td>14</td><td>quarter</td></tr>" +
				'<tr><td colspan="2" rowspan="99">Total</td><td>26</td></tr></table>',
		);
		const lines = (await loadTextDocument(path)).text.trim().split("\n");
		expect(lines).toEqual([
			"| Item | Price | Unit |",
			"| --- | --- | --- |",
			"| Wheat | 12 | bushel |",
			"| | 14 | quarter |",
			"| Total | | 26 |",
		]);
	});
});

describe("chunking safety", () => {
	it("keeps chunks whole-line ranges, an overlong line as a chunk of its own", () => {
		const long = `a${"\u{1F600}".repeat(600)}`;
		const text = ["Short line one.", "", long, "", "Short line five."].join("\n");
		const { chunks } = chunkText(text, 100);
		expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
			[1, 2],
			[3, 3],
			[4, 5],
		]);
		expect(chunks[1].text).toBe(long);
		for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
	});

	it("rejects line ranges that are out of order or overlap", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);
		expect(() => chunksFromLineRanges(lines, "(1, 4)\n(3, 8)\n")).toThrow(/overlaps/);
		expect(() => chunksFromLineRanges(lines, "(5, 8)\n(1, 4)\n")).toThrow(/out of order/);
	});
});

describe("schema fingerprint", () => {
	it("ignores line endings and includes the rules file", () => {
		const text = JSON.stringify(
			{ name: "Fingerprint", strict: true, schema: { type: "object", properties: { entries: { type: "array" } } } },
			null,
			2,
		);
		const lfDir = tempDir();
		const crlfDir = tempDir();
		writeFileSync(join(lfDir, "fingerprint.json"), text);
		writeFileSync(join(crlfDir, "fingerprint.json"), text.replace(/\n/g, "\r\n"));
		const lf = loadSchemaFile(join(lfDir, "fingerprint.json"));
		expect(loadSchemaFile(join(crlfDir, "fingerprint.json")).sha256).toBe(lf.sha256);
		mkdirSync(join(lfDir, "rules"));
		writeFileSync(join(lfDir, "rules", "Fingerprint.rules.json"), '{"verbatimFields": ["a"]}');
		const withRules = loadSchemaFile(join(lfDir, "fingerprint.json"));
		expect(withRules.sha256).not.toBe(lf.sha256);
		writeFileSync(join(lfDir, "rules", "Fingerprint.rules.json"), '{"verbatimFields": ["b"]}');
		expect(loadSchemaFile(join(lfDir, "fingerprint.json")).sha256).not.toBe(withRules.sha256);
	});
});

describe("bundled schema copies", () => {
	// The transcription copies stay at ChronoTranscriber's version of 02.10.2026, which the benchmark used.
	const root = join(import.meta.dirname, "..");
	const dir = join(root, "schemas", "extraction");
	const source = join(root, "..", "ChronoMiner", "schemas");
	it.skipIf(!existsSync(source))("match ChronoMiner", () => {
		const copies = readdirSync(dir).filter((name) => existsSync(join(source, name)));
		expect(copies.length).toBeGreaterThan(0);
		const lf = (path: string) => readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
		for (const name of copies) expect(lf(join(dir, name)), name).toBe(lf(join(source, name)));
	});
});

describe("schemas command", () => {
	it("shows schema files that could not be loaded", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "broken.json"), "{ not json");
		let stdout = "";
		const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			return true;
		});
		try {
			expect(await cli(["schemas", "--schemas-dir", dir])).toBe(0);
			expect(stdout).toMatch(/could not load: .*broken\.json: invalid JSON/);
			stdout = "";
			expect(await cli(["schemas", "--schemas-dir", dir, "--json"])).toBe(0);
		} finally {
			spy.mockRestore();
		}
		const result = JSON.parse(stdout) as { load_errors: Array<{ path: string; error: string }> };
		expect(result.load_errors).toHaveLength(1);
		expect(result.load_errors[0].path).toBe(join(dir, "broken.json"));
	});
});

describe("CLI arguments", () => {
	it("maps flags onto config keys", () => {
		const parsed = parseArgs([
			"extract",
			"a.pdf",
			"b.md",
			"--schema",
			"PriceListEntries",
			"--units-per-session=10",
			"--compact-at",
			"120000",
			"--tool-cap",
			"20",
			"--context-image",
			"hand.png",
			"--no-bash",
			"--force",
			"--thinking",
			"medium",
		]);
		expect(parsed.command).toBe("extract");
		expect(parsed.positionals).toEqual(["a.pdf", "b.md"]);
		const config = mergeConfig(parsed.overrides);
		expect(config.unitsPerSession).toBe(10);
		expect(config.compactAtTokens).toBe(120000);
		expect(config.toolSoftCap).toBe(20);
		expect(config.toolHardCap).toBe(40);
		expect(config.contextImages[0]).toMatch(/hand\.png$/);
		expect(config.bash).toBe(false);
		expect(config.force).toBe(true);
		expect(config.thinking).toBe("medium");
		expect(() => parseArgs(["transcribe", "--bogus", "1"])).toThrow(/Unknown option/);
	});
});

async function captureCli(args: string[]): Promise<{ code: number; stdout: string }> {
	let stdout = "";
	const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	});
	try {
		return { code: await cli(args), stdout };
	} finally {
		spy.mockRestore();
	}
}

describe("config validation", () => {
	it("rejects values that would be misread or make a run impossible", () => {
		expect(coerceConfigValue("groundingThreshold", "0.8", ".")).toBe(0.8);
		expect(coerceConfigValue("groundingThreshold", 1, ".")).toBe(1);
		expect(() => coerceConfigValue("groundingThreshold", "0,8", ".")).toThrow(/groundingThreshold/);
		expect(() => coerceConfigValue("groundingThreshold", "1.5", ".")).toThrow(/at most 1/);
		expect(() => coerceConfigValue("groundingThreshold", 0, ".")).toThrow(/above 0/);
		expect(coerceConfigValue("compactAtTokens", "250,000", ".")).toBe(250000);
		expect(coerceConfigValue("compactAtTokens", 0, ".")).toBe(0);
		for (const key of ["dpi", "unitsPerSession", "toolSoftCap", "toolHardCap", "chunkTokens"] as const) {
			expect(() => coerceConfigValue(key, 0, "."), key).toThrow(/at least 1/);
			expect(() => coerceConfigValue(key, "", "."), key).toThrow();
		}
		expect(() => parseArgs(["transcribe", "x.pdf", "--dpi", "0"])).toThrow(/dpi/);
	});

	it("rejects a soft tool cap above the hard cap instead of raising the hard cap", () => {
		expect(() => mergeConfig({ toolSoftCap: 50 })).toThrow(/toolSoftCap.*toolHardCap/);
		expect(() => mergeConfig({ toolSoftCap: 30, toolHardCap: 20 })).toThrow(/must not exceed/);
		expect(mergeConfig({ toolSoftCap: 45, toolHardCap: 50 }).toolHardCap).toBe(50);
	});
});

describe("agent messages and prompts", () => {
	const units = (indexes: number[], carry: Record<number, string> = {}): UnitRecord[] =>
		indexes.map((index) => ({
			id: `p${String(index).padStart(4, "0")}`,
			index,
			status: "committed",
			...(carry[index] ? { carryOver: carry[index] } : {}),
		}));

	it("passes carry-over notes only where the continuation can reach", () => {
		const all = units([1, 2, 3], { 1: "ends with 'butter'", 2: "ends with 'salt'" });
		const runtime = (inputKind: "images" | "text") =>
			({ inputKind, state: { units: all } }) as unknown as SessionRuntime;
		const pageNote = carryOverNote(runtime("images"), all[2]) ?? "";
		expect(pageNote).toContain("p0002");
		expect(pageNote).not.toContain("p0001");
		const chunkNote = carryOverNote(runtime("text"), all[2]) ?? "";
		expect(chunkNote).toMatch(/Carry-over from p0001: .*Only if that entry reaches this unit/);
		expect(chunkNote).toMatch(/Carry-over from p0002: .*continues into this unit/);
	});

	it("lists the ids of a non-contiguous session batch", () => {
		expect(batchRange({ batch: units([1, 2, 3]) })).toBe("p0001-p0003");
		expect(batchRange({ batch: units([2, 5, 6]) })).toBe("p0002, p0005, p0006");
		expect(batchRange({ batch: units([4]) })).toBe("p0004");
	});

	it("takes the uncertainty markers from the schema", () => {
		const body = (name: string) => {
			const schema = resolveSchema(name, "transcribe", []);
			const props = schema.schema.properties as Record<string, { description?: string }>;
			return uncertaintyInstruction(props.transcription.description ?? "");
		};
		expect(body(CATALOGUE_TRANSCRIPTION_SCHEMA)).toContain("[illegible]");
		expect(body(CATALOGUE_TRANSCRIPTION_SCHEMA)).not.toContain("<gap/>");
		expect(body("plain_text_transcription_schema")).toMatch(/no markup/);
		expect(body("diplomatic_markdown_transcription")).toContain("<unclear>");
		expect(body("markdown_transcription_schema")).toContain("<gap/>");
	});
});

describe("page views", () => {
	const limits = { maxEdge: 2000, maxPixels: 4_000_000, maxBytes: 5_000_000 };
	const pixel = async (enhance: Enhancement[]) => {
		const gray = await sharp({
			create: { width: 16, height: 16, channels: 3, background: { r: 130, g: 130, b: 130 } },
		})
			.png()
			.toBuffer();
		const view = await prepareImage(`gray-${enhance.join("-")}`, gray, { enhance, limits });
		const { data } = await sharp(Buffer.from(view.data, "base64")).raw().toBuffer({ resolveWithObject: true });
		return data[0];
	};

	it("applies enhancements in the order given", async () => {
		// Gray 130: threshold (140) gives black, then invert white; invert gives 125, then threshold black.
		expect(await pixel(["threshold", "invert"])).toBeGreaterThan(200);
		expect(await pixel(["invert", "threshold"])).toBeLessThan(50);
	});

	it("labels grid lines distinctly at deep zoom", () => {
		expect(gridLabels(0, 1)).toEqual(["0.10", "0.20", "0.30", "0.40", "0.50", "0.60", "0.70", "0.80", "0.90"]);
		for (const [start, size] of [
			[0.5, 0.04],
			[0.5, 0.01],
			[0.123, 0.0011],
			[0.3, 0.001],
		]) {
			expect(new Set(gridLabels(start, size)).size, `${start} ${size}`).toBe(9);
		}
	});
});

describe("tui start", () => {
	it("exits with 2 and a message when mabillon.yaml is invalid", async () => {
		const dir = tempDir();
		writeFileSync(join(dir, "mabillon.yaml"), "tool_soft_cap: 50\n");
		const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
		let stderr = "";
		const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr += String(chunk);
			return true;
		});
		try {
			expect(await cli(["tui"])).toBe(2);
		} finally {
			cwd.mockRestore();
			err.mockRestore();
		}
		expect(stderr).toMatch(/toolSoftCap/);
	});
});

describe("verify command schema choice", () => {
	it("prefers the recorded schema over mabillon.yaml, but not over --schema", async () => {
		const dir = tempDir();
		const output = join(dir, "book.json");
		writeFileSync(
			output,
			JSON.stringify({
				mabillon: { schema: { name: "markdown_transcription_schema" } },
				pages: [
					{
						page: 1,
						unit: "p0001",
						status: "committed",
						image_analysis: "one column",
						transcription: "**CATALOGUE.**\n\nAn entry.",
						no_transcribable_text: false,
						transcription_not_possible: false,
					},
				],
			}),
		);
		const yaml = join(dir, "mabillon.yaml");
		writeFileSync(yaml, "schema: plain_text_transcription_schema\n");
		const recorded = await captureCli(["verify", output, "--config", yaml, "--json"]);
		expect(JSON.parse(recorded.stdout)).toMatchObject({ schema: "markdown_transcription_schema", warnings: 0 });
		const explicit = await captureCli([
			"verify",
			output,
			"--config",
			yaml,
			"--schema",
			"diplomatic_markdown_transcription",
			"--json",
		]);
		expect(JSON.parse(explicit.stdout).schema).toBe("diplomatic_markdown_transcription");
	});
});

describe("status", () => {
	it("reports committed units whose canonical copy is missing or changed as damaged and pending", async () => {
		const docDir = join(tempDir(), "book");
		const committed = join(docDir, "run", "committed");
		mkdirSync(committed, { recursive: true });
		const good = "---\nimage_analysis: x\n---\nPage one";
		writeFileSync(join(committed, "p0001.md"), good);
		writeFileSync(join(committed, "p0002.md"), "changed afterwards");
		const record = (index: number, contentHash: string): UnitRecord => ({
			id: `p000${index}`,
			index,
			status: "committed",
			contentHash,
		});
		const state = {
			version: 2,
			mabillonVersion: "0.1.0",
			mode: "transcribe",
			inputKind: "images",
			source: "book.pdf",
			stem: "book",
			fingerprint: { source: "x" },
			schema: { name: "diplomatic_markdown_transcription", sha256: "x", path: "x" },
			units: [record(1, sha256Text(good)), record(2, sha256Text("original")), record(3, sha256Text("gone"))],
			sessions: [],
			createdAt: "2026-10-04T00:00:00Z",
			updatedAt: "2026-10-04T00:00:00Z",
		};
		writeFileSync(join(docDir, "run", "state.json"), JSON.stringify(state));
		const [status] = collectStatus(docDir);
		expect(status.committed).toBe(1);
		expect(status.pending).toBe(2);
		expect(status.complete).toBe(false);
		expect(status.damaged.map((item) => item.unit)).toEqual(["p0002", "p0003"]);
		const result = JSON.parse((await captureCli(["status", docDir, "--json"])).stdout);
		expect(result.documents[0].units_damaged).toHaveLength(2);
	});
});
