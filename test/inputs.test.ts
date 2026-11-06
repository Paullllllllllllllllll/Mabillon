import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { zipSync } from "fflate";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { type DocState, docPaths } from "../src/agent/state.ts";
import { mergeConfig } from "../src/config.ts";
import { run } from "../src/driver.ts";
import { discoverDocuments } from "../src/inputs/discover.ts";
import { boundaryScore, chunkText, lineRangeIssues, loadTextDocument } from "../src/inputs/text.ts";
import { tiffSubfileTypes } from "../src/inputs/tiff.ts";
import { writeOutputs } from "../src/outputs.ts";
import { resolveSchema } from "../src/schemas/registry.ts";
import { decodeText } from "../src/util.ts";
import {
	call,
	createFauxRuntime,
	GUIDE_SCHEMA,
	makeImageFolder,
	messageText,
	RECIPES_SCHEMA,
	say,
	tempDir,
} from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("discovery", () => {
	it("finds PDFs and text files in nested folders", () => {
		const root = tempDir();
		mkdirSync(join(root, "box1", "folder"), { recursive: true });
		writeFileSync(join(root, "box1", "letter.pdf"), "");
		writeFileSync(join(root, "box1", "folder", "notes.txt"), "x");
		writeFileSync(join(root, "context_of_war_1914.pdf"), "");
		const { documents } = discoverDocuments([root], "extract");
		expect(documents.map((doc) => doc.stem).sort()).toEqual(["context_of_war_1914", "letter", "notes"]);
		const explicit = discoverDocuments([join(root, "context.md")], "extract");
		writeFileSync(join(root, "context.md"), "x");
		const named = discoverDocuments([join(root, "context.md")], "extract");
		expect(explicit.documents).toHaveLength(0);
		expect(named.skipped[0].reason).toMatch(/context file/);
	});
});

describe("text conversion", () => {
	it("keeps tables, empty cells, superscripts and literal punctuation in HTML", async () => {
		const root = tempDir();
		const html = join(root, "prices.html");
		writeFileSync(
			html,
			`<html><head><title>Book title</title></head><body>
			<p>12. Take 2 lb. of *butter* [sic] and x<sup>2</sup>.</p>
			<table><tr><th>Item</th><th>1820</th><th>1821</th></tr>
			<tr><td>Bread</td><td></td><td>3 s.</td></tr>
			<tr><td>Beef</td><td>8 d.</td><td></td></tr></table></body></html>`,
		);
		const { text } = await loadTextDocument(html);
		expect(text).not.toContain("Book title");
		expect(text).toContain("12. Take 2 lb. of *butter* [sic] and x<sup>2</sup>.");
		expect(text).toContain("| Item | 1820 | 1821 |");
		expect(text).toContain("| Bread | | 3 s. |");
		expect(text).toContain("| Beef | 8 d. | |");
	});

	it("reads EPUBs with prefixed package elements and only unpacks spine files", async () => {
		const root = tempDir();
		const enc = (text: string) => new TextEncoder().encode(text);
		const epub = zipSync({
			mimetype: enc("application/epub+zip"),
			"META-INF/container.xml": enc(
				'<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
			),
			"OEBPS/content.opf": enc(
				'<opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:manifest><opf:item id="c1" href="ch%201.xhtml"/><opf:item id="bad" href="b%ZZ.xhtml"/></opf:manifest><opf:spine><opf:itemref idref="c1"/></opf:spine></opf:package>',
			),
			"OEBPS/ch 1.xhtml": enc("<html><body><h1>Chapter</h1><p>To make a Tart.</p></body></html>"),
		});
		const path = join(root, "book.epub");
		writeFileSync(path, epub);
		const { text } = await loadTextDocument(path);
		expect(text).toContain("# Chapter");
		expect(text).toContain("To make a Tart.");
	});

	it("decodes entities in EPUB hrefs and refuses spine chapters it cannot find", async () => {
		const root = tempDir();
		const enc = (text: string) => new TextEncoder().encode(text);
		const epub = (spine: string) =>
			zipSync({
				mimetype: enc("application/epub+zip"),
				"META-INF/container.xml": enc(
					'<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
				),
				"OEBPS/content.opf": enc(
					`<package><manifest><item id="c1" href="first.xhtml"/><item id="c2" href="second&amp;recipes.xhtml#top"/><item id="gone" href="lost.xhtml"/></manifest><spine>${spine}</spine></package>`,
				),
				"OEBPS/first.xhtml": enc("<html><body><p>First chapter.</p></body></html>"),
				"OEBPS/second&recipes.xhtml": enc("<html><body><p>Second chapter.</p></body></html>"),
			});
		const good = join(root, "good.epub");
		writeFileSync(good, epub('<itemref idref="c1"/><itemref idref="c2"/>'));
		const { text } = await loadTextDocument(good);
		expect(text).toContain("First chapter.");
		expect(text).toContain("Second chapter.");
		const missing = join(root, "missing.epub");
		writeFileSync(missing, epub('<itemref idref="c1"/><itemref idref="gone"/>'));
		await expect(loadTextDocument(missing)).rejects.toThrow(/lost\.xhtml named in the spine is missing/);
		const unknown = join(root, "unknown.epub");
		writeFileSync(unknown, epub('<itemref idref="c1"/><itemref idref="nope"/>'));
		await expect(loadTextDocument(unknown)).rejects.toThrow(/"nope", which is not in the manifest/);
	});

	it("keeps UTF-8 when only a few bytes are legacy", () => {
		const good = Buffer.from("Größe und Maß. ".repeat(500), "utf8");
		const result = decodeText(Buffer.concat([good, Buffer.from([0x20, 0x47, 0x72, 0xf6, 0xdf, 0x65])]));
		expect(result.text).toContain("Größe und Maß.");
		expect(result.text.endsWith(" Größe")).toBe(true);
		expect(result.warning).toMatch(/2 byte/);
	});

	it("cuts transcripts at page separators, not after them", () => {
		const lines = [
			"<!-- page 1 (p0001) -->",
			"",
			"First page text.",
			"",
			"<!-- page 2 (p0002) -->",
			"",
			"Second page.",
		];
		expect(boundaryScore(lines, 4)).toBeGreaterThan(boundaryScore(lines, 6));
		expect(boundaryScore(lines, 6)).toBeLessThan(0);
		const pages = Array.from(
			{ length: 30 },
			(_, i) =>
				`<!-- page ${i + 1} (p${String(i + 1).padStart(4, "0")}) -->\n\n${"Some text of the page. ".repeat(20)}`,
		).join("\n\n");
		const { chunks } = chunkText(pages, 400);
		expect(chunks.length).toBeGreaterThan(2);
		for (const chunk of chunks) expect(chunk.text.startsWith("<!-- page")).toBe(true);
	});

	it("reports gaps and overlaps in line ranges", () => {
		const chunk = (startLine: number, endLine: number) => ({ index: 0, startLine, endLine, text: "" });
		expect(lineRangeIssues([chunk(1, 40), chunk(51, 80), chunk(70, 90)], 100)).toEqual([
			"lines 41-50 are in no range",
			"lines 70-80 are in more than one range",
			"lines 91-100 are in no range",
		]);
		expect(lineRangeIssues([chunk(1, 50), chunk(51, 100)], 100)).toEqual([]);
	});
});

describe("review round 3", () => {
	it("does not treat a custom output folder inside the input tree as input", () => {
		const root = tempDir();
		writeFileSync(join(root, "letters.txt"), "x");
		mkdirSync(join(root, "results", "letters", "run"), { recursive: true });
		writeFileSync(join(root, "results", "letters", "run", "state.json"), "{}");
		writeFileSync(join(root, "results", "letters", "letters.json"), "{}");
		mkdirSync(join(root, "elsewhere", "doc", "run"), { recursive: true });
		writeFileSync(join(root, "elsewhere", "doc", "run", "state.json"), "{}");
		writeFileSync(join(root, "elsewhere", "doc", "doc.json"), "{}");
		const { documents } = discoverDocuments([root], "extract", [join(root, "results")]);
		expect(documents.map((doc) => doc.stem)).toEqual(["letters"]);
	});

	it("reads the reduced-resolution flag of TIFF directories", async () => {
		const root = tempDir();
		const path = join(root, "pyramid.tif");
		await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "#fff" } })
			.tiff({ pyramid: true, tile: true })
			.toFile(path);
		const types = tiffSubfileTypes(path);
		expect(types?.[0]).toBe(0);
		expect(types?.slice(1).every((type) => (type & 1) === 1)).toBe(true);
		expect(tiffSubfileTypes(join(root, "missing.tif"))).toBeUndefined();
	});

	it("keeps lines and captions of table cells apart", async () => {
		const root = tempDir();
		const html = join(root, "t.html");
		writeFileSync(
			html,
			"<table><caption>Table 3. Baptisms, 1747</caption><tr><th>Name</th><th>Address</th></tr><tr><td><p>Johann</p><p>Müller</p></td><td>Hauptgasse 3<br>Basel</td></tr></table>",
		);
		const { text } = await loadTextDocument(html);
		expect(text).toContain("Table 3. Baptisms, 1747");
		expect(text).toContain("| Johann<br>Müller | Hauptgasse 3<br>Basel |");
	});

	it("converts a minimal DOCX", async () => {
		const root = tempDir();
		const enc = (text: string) => new TextEncoder().encode(text);
		const docx = zipSync({
			"[Content_Types].xml": enc(
				'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
			),
			"_rels/.rels": enc(
				'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
			),
			"word/document.xml": enc(
				'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>12. Take a Pullet.</w:t></w:r></w:p></w:body></w:document>',
			),
		});
		const path = join(root, "recipe.docx");
		writeFileSync(path, docx);
		expect((await loadTextDocument(path)).text.trim()).toBe("12. Take a Pullet.");
	});

	it("reads legacy text with accidental UTF-8 sequences as Windows-1252", () => {
		const french = Buffer.from("Il est là » et voilà, très bien. Ça coûte cher. ", "latin1");
		const bytes = Buffer.concat(Array.from({ length: 20 }, () => french));
		const decoded = decodeText(bytes);
		expect(decoded.encoding).toBe("windows-1252");
		expect(decoded.text).toContain("Il est là » et voilà");
	});
});

describe("outputs", () => {
	it("keeps the text of a page without front matter that was closed for review", () => {
		const root = tempDir();
		const paths = docPaths(join(root, "doc"));
		mkdirSync(paths.committedDir, { recursive: true });
		writeFileSync(join(paths.committedDir, "p0001.md"), "Just the text, no front matter.");
		const schema = resolveSchema(undefined, "transcribe", []);
		const state = {
			version: 2,
			mode: "transcribe",
			inputKind: "images",
			source: "x",
			stem: "doc",
			fingerprint: { source: "x" },
			schema: { name: schema.name, sha256: schema.sha256, path: schema.path },
			units: [{ id: "p0001", index: 1, status: "needs_review", closedReason: "tool budget" }],
			sessions: [],
			createdAt: "",
			updatedAt: "",
		} as unknown as DocState;
		// The draft of a page closed for review stays in the sidecar (the store and the text files mark it failed).
		const out = writeOutputs(paths, state, schema);
		const json = JSON.parse(readFileSync(out.sidecar, "utf8"));
		expect(json.pages[0].transcription).toBe("Just the text, no front matter.");
		expect(json.pages[0].parse_error).toBeDefined();
	});

	it("records per-page top-level values for every entry", () => {
		const root = tempDir();
		const paths = docPaths(join(root, "guide"));
		mkdirSync(paths.committedDir, { recursive: true });
		const schema = resolveSchema(GUIDE_SCHEMA, "extract", []);
		const props = Object.keys((schema.schema.properties ?? {}) as object);
		expect(props).toContain("active_city_or_town");
		const cities = ["PARIS", "LYON"];
		cities.forEach((city, i) => {
			writeFileSync(
				join(paths.committedDir, `p000${i + 1}.json`),
				JSON.stringify({ contains_no_content_of_requested_type: false, active_city_or_town: city, entries: [{}] }),
			);
		});
		const state = {
			version: 2,
			mode: "extract",
			inputKind: "images",
			source: "x",
			stem: "guide",
			fingerprint: { source: "x" },
			schema: { name: schema.name, sha256: schema.sha256, path: schema.path },
			units: cities.map((_, i) => ({ id: `p000${i + 1}`, index: i + 1, status: "committed" })),
			sessions: [],
			createdAt: "",
			updatedAt: "",
		} as unknown as DocState;
		const out = writeOutputs(paths, state, schema);
		const provenance = JSON.parse(readFileSync(out.sidecar, "utf8"));
		expect(provenance.mabillon.varying_fields).toEqual(["active_city_or_town"]);
		expect(
			provenance.entries.map(
				(entry: { unit_fields: { active_city_or_town: string } }) => entry.unit_fields.active_city_or_town,
			),
		).toEqual(cities);
		expect(provenance.mabillon.schema.path).toBe(schema.path);
	});
});

function diligent(context: TranscriptContext): AssistantMessage {
	const last = context.messages[context.messages.length - 1];
	let unit: string | undefined;
	for (let i = context.messages.length - 1; i >= 0 && !unit; i--) {
		if (context.messages[i].role === "user")
			unit = /Current unit: (p\d+)/.exec(messageText(context.messages[i]))?.[1];
	}
	if (last.role === "user" && unit) {
		return call("write", {
			path: `units/${unit}.md`,
			content: `---\nimage_analysis: x\nno_transcribable_text: false\ntranscription_not_possible: false\n---\nText of ${unit}`,
		});
	}
	if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
	return say("done");
}

describe("runs on unusual inputs", () => {
	async function runWith(
		inputs: string[],
		overrides: Record<string, unknown>,
		mode: "transcribe" | "extract" = "transcribe",
	) {
		const faux = await createFauxRuntime(diligent);
		cleanups.push(faux.cleanup);
		return run({
			mode,
			inputs,
			config: mergeConfig({ model: "faux/faux-1", autoContext: false, ...overrides }),
			log: () => undefined,
			services: {
				modelRuntime: faux.modelRuntime,
				agentDir: faux.agentDir,
				settings: { retry: { enabled: false } },
			},
		});
	}

	it("transcribes one unit per page of a pyramidal TIFF", async () => {
		const root = tempDir();
		mkdirSync(join(root, "scan"));
		await sharp({ create: { width: 2400, height: 3200, channels: 3, background: "#f4ecd8" } })
			.tiff({ pyramid: true, tile: true })
			.toFile(join(root, "scan", "page.tif"));
		const summary = await runWith([join(root, "scan")], { out: join(root, "out") });
		expect(summary.documents[0].units).toBe(1);
		expect(summary.documents[0].committed).toBe(1);
	}, 60_000);

	it("fails documents with no text or no selected unit", async () => {
		const root = tempDir();
		writeFileSync(join(root, "empty.txt"), "\n\n");
		const empty = await runWith(
			[join(root, "empty.txt")],
			{ out: join(root, "out"), schema: RECIPES_SCHEMA },
			"extract",
		);
		expect(empty.documents[0].error).toMatch(/no text found/);
		const folder = await makeImageFolder(join(root, "pages"), 1);
		const none = await runWith([folder], { out: join(root, "out2"), units: "5-9" });
		expect(none.documents[0].error).toMatch(/selects none/);
	}, 60_000);
});

describe("CLI", () => {
	it("prints JSON for argument errors with --json=1", () => {
		const result = spawnSync(
			process.execPath,
			[join(process.cwd(), "src", "bin.ts"), "transcribe", "--bogus", "--json=1"],
			{
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exit_code: 2 });
	});
});
