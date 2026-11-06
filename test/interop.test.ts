import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { inputIdentity } from "../src/chrono/identity.ts";
import { realPath } from "../src/chrono/paths.ts";
import { renderCsv, renderOutputJson } from "../src/chrono/render-cm.ts";
import { renderDocument } from "../src/chrono/render-ct.ts";
import { Connection, readOnly } from "../src/chrono/sqlite.ts";
import { ChronoStore, LEASE_TTL, refreshDocument } from "../src/chrono/store.ts";
import { type ChronoConfig, mergeConfig } from "../src/config.ts";
import { run } from "../src/driver.ts";
import {
	call,
	createFauxRuntime,
	makeImageFolder,
	makePdf,
	messageText,
	outputFile,
	readSidecar,
	say,
	sidecarFile,
	tempDir,
} from "./helpers.ts";

/**
 * Mabillon's ChronoTranscriber and ChronoMiner outputs, with a scripted faux model. With MABILLON_INTEROP_OUT set,
 * the scenarios of the first two blocks are written there (one folder each, with a scenario.json) for
 * test/interop/check.py, which opens them with the tools' own code.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const EXPORT = process.env.MABILLON_INTEROP_OUT;

function scenarioDir(name: string): string {
	if (!EXPORT) return tempDir();
	const dir = join(EXPORT, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return realPath(dir);
}

function describeScenario(dir: string, scenario: Record<string, unknown>): void {
	writeFileSync(join(dir, "scenario.json"), `${JSON.stringify(scenario, null, 2)}\n`);
}

function currentUnit(context: TranscriptContext): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const match = /Current unit: ([pc]\d+)/.exec(messageText(message));
		if (match) return match[1];
	}
	return undefined;
}

const PAGE =
	"---\nimage_analysis: one column of roman type\nno_transcribable_text: false\ntranscription_not_possible: false\n---\n";
const BLANK = "---\nimage_analysis: blank page\nno_transcribable_text: true\ntranscription_not_possible: false\n---\n";

/** Transcribes every page, except `blank` (no text) and `stop` (the agent stops, so the page is closed for review). */
function transcriber(options: { blank?: string[]; stop?: string[] } = {}) {
	return (context: TranscriptContext): AssistantMessage => {
		const last = context.messages[context.messages.length - 1];
		const unit = currentUnit(context);
		if (unit && options.stop?.includes(unit)) return say("I am done with this page.");
		if (last.role === "user" && unit) {
			const content = options.blank?.includes(unit)
				? BLANK
				: `${PAGE}<page_number>${Number(unit.slice(1))}</page_number>\nTake ſpinage for ${unit}.\n\nThen boyle it.`;
			return call("write", { path: `units/${unit}.md`, content });
		}
		if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
		return say("done");
	};
}

const PRICE_SCHEMA = {
	name: "InteropPrices",
	strict: true,
	schema: {
		type: "object",
		properties: {
			contains_no_content_of_requested_type: { type: "boolean" },
			entries: {
				type: "array",
				items: {
					type: "object",
					properties: {
						item: { type: "string" },
						price: {
							type: "object",
							properties: { amount: { type: ["number", "null"] }, currency: { type: "string" } },
							required: ["amount", "currency"],
							additionalProperties: false,
						},
						tags: { type: "array", items: { type: "string" } },
						page: { type: "integer" },
						checked: { type: "boolean" },
					},
					required: ["item", "price", "tags", "page", "checked"],
					additionalProperties: false,
				},
			},
		},
		required: ["contains_no_content_of_requested_type", "entries"],
		additionalProperties: false,
	},
};

function writePriceSchema(dir: string): string {
	const path = join(dir, "schemas", "interop_prices.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(PRICE_SCHEMA, null, 2)}\n`);
	return path;
}

/** Extracts one entry per unit (from the chunk text or the page), committing it. */
function extractor(options: { stop?: string[] } = {}) {
	return (context: TranscriptContext): AssistantMessage => {
		const last = context.messages[context.messages.length - 1];
		const unit = currentUnit(context);
		if (unit && options.stop?.includes(unit)) return say("Nothing more to do.");
		if (last.role === "user" && unit) {
			const n = Number(unit.slice(1));
			const data = {
				contains_no_content_of_requested_type: false,
				entries: [
					{
						item: `Pepper, "best" ${unit}`,
						price: { amount: n === 2 ? null : n * 1.5, currency: "fl" },
						tags: ["spice", `unit ${n}`],
						page: n,
						checked: n % 2 === 1,
					},
				],
			};
			return call("write", { path: `units/${unit}.json`, content: JSON.stringify(data, null, 2) });
		}
		if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
		if (last.role === "toolResult" && last.toolName === "verify" && /NOT COMMITTED/.test(messageText(last))) {
			return call("verify", { final: true });
		}
		return say("done");
	};
}

async function harness(responder: (context: TranscriptContext) => AssistantMessage, overrides: Partial<ChronoConfig>) {
	const faux = await createFauxRuntime(responder);
	cleanups.push(faux.cleanup);
	const config = mergeConfig({ model: "faux/faux-1", autoContext: false, settleRetries: 0, ...overrides });
	const logs: string[] = [];
	return {
		logs,
		run: (mode: "transcribe" | "extract", inputs: string[]) =>
			run({
				mode,
				inputs,
				config,
				log: (message) => logs.push(message),
				services: { modelRuntime: faux.modelRuntime, agentDir: faux.agentDir, settings: {} },
			}),
	};
}

function query<T = Record<string, unknown>>(database: string, sql: string, ...params: Array<string | number>): T[] {
	return readOnly(database, (c) => c.all(sql, ...params)) as T[];
}

const RECIPES_TEXT = Array.from({ length: 8 }, (_, i) =>
	[
		`## Pepper ${i + 1}`,
		"",
		`Pepper of the best sort, ${i + 1} pound, ${i + 2} florins.`,
		"Sold at the Kornmarkt.",
	].join("\n"),
).join("\n\n");

describe("ChronoTranscriber outputs", () => {
	it("writes the hash layout, the store rows and files a CT render reproduces", async () => {
		const dir = scenarioDir("ct-pdf-hash");
		mkdirSync(join(dir, "in"), { recursive: true });
		const pdf = makePdf(join(dir, "in", "receipts.pdf"), ["First page", "Second page", "Third page"]);
		const out = join(dir, "out");
		const h = await harness(transcriber({ stop: ["p0002"], blank: ["p0003"] }), {
			out,
			dpi: 72,
			formats: ["txt", "md"],
		});
		const summary = await h.run("transcribe", [pdf]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc).toMatchObject({ committed: 2, needsReview: 1, pending: 0 });
		const database = join(realPath(out), "chronotranscriber.sqlite");
		expect(doc.outputs?.store).toBe(database);
		const txt = outputFile(out, "receipts.txt");
		expect(basename(dirname(txt))).toMatch(/^receipts-[0-9a-f]{8}$/);
		const name = `${basename(dirname(txt))}/receipts`;
		const [document] = query(database, "SELECT * FROM documents WHERE name = ?", name);
		expect(document).toMatchObject({
			tool: "mabillon",
			kind: "pdf",
			status: "failed",
			units_total: 3,
			units_done: 2,
			units_failed: 1,
			units_pending: 0,
			input_path: realPath(pdf),
			input_sha256: inputIdentity(pdf),
			lease_run_id: null,
		});
		const units = query(
			database,
			"SELECT idx, status, outcome, label, source_index, typeof(source_index) AS t, content, tool FROM units ORDER BY idx",
		);
		expect(units.map((unit) => [unit.status, unit.outcome, unit.label, unit.t])).toEqual([
			["done", "ok", "page_0001_pre_processed.jpg", "integer"],
			["failed", "failed", "page_0002_pre_processed.jpg", "integer"],
			["done", "no_text", "page_0003_pre_processed.jpg", "integer"],
		]);
		expect(units[1].content).toBeNull();
		const expected = "<page_number>1</page_number>\nTake ſpinage for p0001.\n\nThen boyle it.";
		expect(units[0].content).toBe(expected);
		const txtText = `${expected}\npage_0002_pre_processed.jpg: [transcription error]\npage_0003_pre_processed.jpg: [No transcribable text]\n`;
		expect(readFileSync(txt, "utf8")).toBe(txtText);
		readOnly(database, (c) => {
			expect(renderDocument(c, Number(document.doc_id), "txt")).toBe(txtText);
			expect(renderDocument(c, Number(document.doc_id), "md")).toBe(
				readFileSync(outputFile(out, "receipts.md"), "utf8"),
			);
		});
		// Rendered files are registered with their hash; the run, prompt, schema and the page_text view are there.
		const outputs = query(database, "SELECT path, format, stale FROM outputs ORDER BY path");
		expect(outputs).toEqual([
			{ path: `${name}.md`, format: "md", stale: 0 },
			{ path: `${name}.txt`, format: "txt", stale: 0 },
		]);
		expect(query(database, "SELECT tool, command, exit_code FROM runs")).toEqual([
			{ tool: "mabillon", command: "transcribe", exit_code: 3 },
		]);
		expect(query(database, "SELECT kind FROM artifacts ORDER BY kind").map((row) => row.kind)).toEqual([
			"prompt",
			"schema",
		]);
		expect(query(database, "SELECT count(*) AS n FROM page_text")[0].n).toBe(3);
		// The draft of the page closed for review stays in the sidecar; the working folder sits in .mabillon.
		const sidecar = readSidecar(out, "receipts");
		expect(sidecar.pages[1].status).toBe("needs_review");
		expect(sidecar.mabillon.store).toEqual({ database, documents: [name] });
		expect(doc.workingDir).toBe(join(realPath(out), ".mabillon", ...name.split("/")));
		describeScenario(dir, {
			tool: "chronotranscriber",
			mode: "transcribe",
			input: pdf,
			output: realPath(out),
			formats: ["txt", "md"],
			expect: { [name]: "partial" },
			// ChronoTranscriber retries failed pages by default; without that the document is complete.
			plans: [
				{ args: [], expect: { [name]: "partial" } },
				{ args: ["--no-retry-errors"], expect: { [name]: "complete" } },
			],
			repair: { [name]: [1] },
		});
	}, 120_000);

	it("writes beside the input and stores every page, unworked ones as pending", async () => {
		const dir = scenarioDir("ct-folder-beside");
		const folder = await makeImageFolder(join(dir, "in", "scans"), 3);
		const h = await harness(transcriber(), { units: "1-2" });
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0]).toMatchObject({ committed: 2, pending: 0, selected: 2, units: 3 });
		const root = realPath(join(dir, "in"));
		expect(existsSync(join(root, "scans.txt"))).toBe(true);
		// txt alone by default: a .md beside it would give ChronoMiner two inputs named scans.
		expect(existsSync(join(root, "scans.md"))).toBe(false);
		expect(existsSync(join(root, "scans.mabillon.json"))).toBe(true);
		expect(existsSync(join(root, ".mabillon", "scans", "run", "state.json"))).toBe(true);
		const database = join(root, "chronotranscriber.sqlite");
		const units = query(database, "SELECT idx, status, label, source_index FROM units ORDER BY idx");
		expect(units.map((unit) => unit.status)).toEqual(["done", "done", "pending"]);
		expect(units[2]).toMatchObject({
			label: "scan_3.png_pre_processed.jpg",
			source_index: "scan_3.png_pre_processed.jpg",
		});
		expect(query(database, "SELECT status, input_sha256 FROM documents")[0]).toEqual({
			status: "partial",
			input_sha256: inputIdentity(folder),
		});
		describeScenario(dir, {
			tool: "chronotranscriber",
			mode: "transcribe",
			input: realPath(folder),
			output: null,
			formats: ["txt"],
			expect: { scans: "partial" },
		});
	}, 120_000);
});

describe("ChronoMiner outputs", () => {
	it("writes _output.json and the CSV of a text, with chunk units, entries and run metadata", async () => {
		const dir = scenarioDir("cm-text");
		mkdirSync(join(dir, "in"), { recursive: true });
		const text = join(dir, "in", "prices.md");
		writeFileSync(text, `${RECIPES_TEXT}\n`);
		const out = join(dir, "out");
		const schema = writePriceSchema(dir);
		const h = await harness(extractor(), { out, schema, chunkTokens: 100, formats: ["json", "csv"] });
		const summary = await h.run("extract", [text]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc.pending).toBe(0);
		const root = realPath(out);
		const database = join(root, "chronominer.sqlite");
		const json = readFileSync(join(root, "prices_output.json"), "utf8");
		const csv = readFileSync(join(root, "prices_output.csv"), "utf8");
		const [document] = query(database, "SELECT * FROM documents");
		expect(document).toMatchObject({ name: "prices", kind: "text", status: "complete", input_path: realPath(text) });
		readOnly(database, (c) => {
			expect(renderOutputJson(c, Number(document.doc_id))).toBe(json);
			expect(renderCsv(c, Number(document.doc_id))).toBe(csv);
		});
		const parsed = JSON.parse(json);
		expect(parsed._chronominer_metadata).toMatchObject({
			schema_name: "InteropPrices",
			model_name: "faux-1",
			chunking_method: "mabillon",
			total_chunks: doc.units,
			document_total_chunks: doc.units,
			version: 1,
		});
		expect(parsed.records[0]).toMatchObject({ custom_id: "prices-chunk-1", chunk_index: 1 });
		expect(csv.split("\n")[0]).toBe("﻿item,price.amount,price.currency,tags,page,checked");
		expect(csv.split("\n")[1]).toBe('"Pepper, ""best"" c0001",1.5,fl,spice; unit 1,1,true');
		expect(csv.split("\n")[2]).toBe('"Pepper, ""best"" c0002",,fl,spice; unit 2,2,false');
		const units = query(
			database,
			"SELECT idx, label, source_index, json_extract(provenance, '$.custom_id') AS id FROM units ORDER BY idx",
		);
		expect(units[0]).toMatchObject({ idx: 0, id: "prices-chunk-1" });
		expect(String(units[0].label)).toMatch(/^1-\d+$/);
		expect(units[0].source_index).toBe(units[0].label);
		// Whole-line ranges that follow each other.
		const ranges = units.map((unit) => String(unit.source_index).split("-").map(Number));
		for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1);
		// The entries view has a typed column per field.
		const entries = query(database, "SELECT document, chunk_index, item, price, tags, page, checked FROM entries");
		expect(entries).toHaveLength(doc.units);
		expect(entries[0]).toMatchObject({ document: "prices", chunk_index: 1, page: 1, checked: 1 });
		expect(JSON.parse(String(entries[0].price))).toEqual({ amount: 1.5, currency: "fl" });
		expect(query(database, "SELECT schema_sha256 FROM document_meta")[0].schema_sha256).toBe(
			query(database, "SELECT sha256 FROM artifacts WHERE kind = 'schema'")[0].sha256,
		);
		expect(readSidecar(out, "prices").merged.entries).toHaveLength(doc.units);
		describeScenario(dir, {
			tool: "chronominer",
			mode: "extract",
			input: realPath(text),
			output: root,
			schema,
			formats: ["json", "csv"],
			expect: { prices: "complete" },
		});
	}, 120_000);

	it("writes one ChronoMiner document per image of a folder", async () => {
		const dir = scenarioDir("cm-images");
		const folder = await makeImageFolder(join(dir, "in", "ledger"), 2);
		const out = join(dir, "out");
		const schema = writePriceSchema(dir);
		const h = await harness(extractor(), { out, schema });
		const summary = await h.run("extract", [folder]);
		expect(summary.documents[0]).toMatchObject({ committed: 2, pending: 0 });
		const root = realPath(out);
		const database = join(root, "chronominer.sqlite");
		const documents = query(database, "SELECT name, kind, status, input_path FROM documents ORDER BY name");
		expect(documents.map((document) => [document.name, document.kind, document.status])).toEqual([
			["scan_1", "image", "complete"],
			["scan_2", "image", "complete"],
		]);
		expect(documents[0].input_path).toBe(join(realPath(folder), "scan_1.png"));
		const records = JSON.parse(readFileSync(join(root, "scan_2_output.json"), "utf8")).records;
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ custom_id: "scan_2-page-1", chunk_index: 1, chunk_range: null });
		expect(existsSync(join(root, "ledger_output.mabillon.json"))).toBe(true);
		expect(existsSync(join(root, ".mabillon", "ledger_output", "run", "state.json"))).toBe(true);
		describeScenario(dir, {
			tool: "chronominer",
			mode: "extract",
			input: realPath(folder),
			output: root,
			schema,
			formats: ["json"],
			expect: { scan_1: "complete", scan_2: "complete" },
		});
	}, 120_000);

	it("stores the pages of a PDF, a page closed for review as failed", async () => {
		const dir = scenarioDir("cm-pdf");
		mkdirSync(join(dir, "in"), { recursive: true });
		const pdf = makePdf(join(dir, "in", "tariff.pdf"), ["Pepper 3 fl", "Nutmeg 5 fl", "Mace 7 fl"]);
		const out = join(dir, "out");
		const schema = writePriceSchema(dir);
		const h = await harness(extractor({ stop: ["p0002"] }), { out, schema, dpi: 72, units: "1-2" });
		const summary = await h.run("extract", [pdf]);
		expect(summary.documents[0]).toMatchObject({ committed: 1, needsReview: 1 });
		const root = realPath(out);
		const database = join(root, "chronominer.sqlite");
		const units = query(
			database,
			"SELECT idx, status, label, source_index, typeof(source_index) AS t FROM units ORDER BY idx",
		);
		expect(units.map((unit) => [unit.status, unit.label, unit.t])).toEqual([
			["done", "page_0001", "integer"],
			["failed", "page_0002", "integer"],
			["pending", "page_0003", "integer"],
		]);
		const meta = JSON.parse(readFileSync(join(root, "tariff_output.json"), "utf8"))._chronominer_metadata;
		expect(meta).toMatchObject({ total_chunks: 3, partial: true, failed_chunks: [2], chunking_method: "pages" });
		describeScenario(dir, {
			tool: "chronominer",
			mode: "extract",
			input: realPath(pdf),
			output: root,
			schema,
			formats: ["json"],
			expect: { tariff: "partial" },
			repair: { tariff: [1] },
		});
	}, 120_000);

	it("records the materialized text of a converted input as the ChronoMiner input", async () => {
		const dir = scenarioDir("cm-html");
		mkdirSync(join(dir, "in"), { recursive: true });
		const html = join(dir, "in", "tariff.html");
		writeFileSync(
			html,
			`<html><body>${RECIPES_TEXT.split("\n\n")
				.map((block) => `<p>${block}</p>`)
				.join("")}</body></html>`,
		);
		const out = join(dir, "out");
		const schema = writePriceSchema(dir);
		const h = await harness(extractor(), { out, schema });
		const summary = await h.run("extract", [html]);
		expect(summary.documents[0].error).toBeUndefined();
		const root = realPath(out);
		const [document] = query(
			join(root, "chronominer.sqlite"),
			"SELECT name, input_path, input_sha256 FROM documents",
		);
		expect(document.name).toBe("tariff");
		// Named by the input's stem, so that ChronoMiner resumes the recorded input as the document 'tariff'.
		expect(document.input_path).toBe(join(root, ".mabillon", "tariff_output", "run", "text", "tariff.txt"));
		const records = JSON.parse(readFileSync(join(root, "tariff_output.json"), "utf8")).records;
		expect(records[0].custom_id).toBe("tariff-chunk-1");
		describeScenario(dir, {
			tool: "chronominer",
			mode: "extract",
			input: String(document.input_path),
			output: root,
			schema,
			formats: ["json"],
			expect: { tariff: "complete" },
		});
	}, 120_000);
});

describe("ChronoMiner rows Mabillon adopts", () => {
	it("renders entries ChronoMiner wrote with Python floats as ChronoMiner does", async () => {
		const dir = scenarioDir("cm-adopt-floats");
		mkdirSync(join(dir, "in"), { recursive: true });
		const text = join(dir, "in", "prices.md");
		writeFileSync(text, `${RECIPES_TEXT}\n`);
		const out = join(dir, "out");
		const schema = writePriceSchema(dir);
		const first = await (await harness(extractor(), { out, schema, chunkTokens: 100, units: "1" })).run("extract", [
			text,
		]);
		expect(first.documents[0].error).toBeUndefined();
		const root = realPath(out);
		const database = join(root, "chronominer.sqlite");
		// Chunk 1 as ChronoMiner writes it: Python's json keeps 3.0 and 1e+16 floats, in the answer and the entry rows.
		const entries = [
			'{"item": "Mace", "price": {"amount": 3.0, "currency": "fl"}, "tags": ["spice"], "page": 1, "checked": true}',
			'{"item": "Saffron", "price": {"amount": 1e+16, "currency": "fl"}, "tags": [], "page": 9007199254740993, "checked": false}',
		];
		const answer = `{"contains_no_content_of_requested_type": false, "entries": [${entries.join(", ")}]}`;
		const connection = new Connection(database);
		connection.transaction((c) => {
			c.run(
				"INSERT INTO runs (run_id, tool, tool_version, command, started_at) VALUES ('cm-run', 'chronominer', '1.0.0', 'extract', '2026-11-01T00:00:00.000+00:00')",
			);
			c.run(
				"UPDATE units SET tool = 'chronominer', run_id = 'cm-run', content = ?, model = 'gpt-6-luna', provider = 'openai' WHERE idx = 0",
				answer,
			);
			c.run("DELETE FROM entry_rows WHERE idx = 0");
			entries.forEach((entry, index) => {
				const value = JSON.parse(entry);
				c.run(
					"INSERT INTO entry_rows (doc_id, kind, idx, entry_index, schema_name, run_id, tool, model, provider, entry, f_item, f_price, f_tags, f_page, f_checked) VALUES (1, 'chunk', 0, ?, 'InteropPrices', 'cm-run', 'chronominer', 'gpt-6-luna', 'openai', ?, ?, ?, ?, ?, ?)",
					index,
					entry,
					value.item,
					/"price": (\{[^}]*\})/.exec(entry)?.[1] ?? null,
					JSON.stringify(value.tags).replace(/","/g, '", "'),
					index === 1 ? 9007199254740993n : 1n,
					value.checked ? 1 : 0,
				);
			});
		});
		connection.close();
		const second = await (
			await harness(extractor(), { out, schema, chunkTokens: 100, formats: ["json", "csv"] })
		).run("extract", [text]);
		expect(second.documents[0].error).toBeUndefined();
		expect(readSidecar(out, "prices").mabillon.units_adopted).toBe(1);
		const csv = readFileSync(join(root, "prices_output.csv"), "utf8").split("\n");
		expect(csv[1]).toBe("Mace,3.0,fl,spice,1,true");
		expect(csv[2]).toBe("Saffron,1e+16,fl,,9007199254740993,false");
		// The committed copy and the sidecar keep the large integer and the floats as ChronoMiner stored them.
		const sidecarText = readFileSync(sidecarFile(out, "prices"), "utf8");
		expect(sidecarText).toContain('"page": 9007199254740993');
		expect(sidecarText).toContain('"amount": 3.0');
		describeScenario(dir, {
			tool: "chronominer",
			mode: "extract",
			input: realPath(text),
			output: root,
			schema,
			formats: ["json", "csv"],
			expect: { prices: "complete" },
		});
	}, 120_000);

	it("refuses chunks of another schema unless --force", async () => {
		const root = tempDir();
		const text = join(root, "prices.md");
		writeFileSync(text, `${RECIPES_TEXT}\n`);
		const schema = writePriceSchema(root);
		const first = await (await harness(extractor(), { schema, chunkTokens: 100, units: "1" })).run("extract", [text]);
		expect(first.documents[0].error).toBeUndefined();
		const changed = { ...PRICE_SCHEMA, schema: { ...PRICE_SCHEMA.schema, description: "Prices, version 2" } };
		writeFileSync(schema, `${JSON.stringify(changed, null, 2)}\n`);
		rmSync(join(realPath(root), ".mabillon"), { recursive: true, force: true });
		const refused = await (await harness(extractor(), { schema, chunkTokens: 100 })).run("extract", [text]);
		expect(refused.documents[0].error).toMatch(/extracted with another schema .*use --force/);
		const forced = await (await harness(extractor(), { schema, chunkTokens: 100, force: true })).run("extract", [
			text,
		]);
		expect(forced.documents[0].error).toBeUndefined();
	}, 120_000);
});

describe("working state and refusals before agent work", () => {
	it("keeps a transcription and the extraction of its text apart", async () => {
		const root = tempDir();
		const pdf = makePdf(join(root, "foo.pdf"), ["Pepper 3 fl"]);
		const transcribed = await (await harness(transcriber(), { dpi: 72 })).run("transcribe", [pdf]);
		expect(transcribed.documents[0].error).toBeUndefined();
		const schema = writePriceSchema(root);
		const extracted = await (await harness(extractor(), { schema })).run("extract", [join(root, "foo.txt")]);
		expect(extracted.documents[0].error).toBeUndefined();
		for (const name of ["foo", "foo_output"]) {
			expect(existsSync(join(root, ".mabillon", name, "run", "state.json"))).toBe(true);
			expect(existsSync(join(root, `${name}.mabillon.json`))).toBe(true);
		}
	}, 120_000);

	it("works a unit again that ChronoTranscriber reset or marked stale", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 3);
		const first = await (await harness(transcriber(), {})).run("transcribe", [folder]);
		expect(first.documents[0].committed).toBe(3);
		const database = join(realPath(root), "chronotranscriber.sqlite");
		const connection = new Connection(database);
		connection.run("INSERT INTO runs (run_id, tool, started_at) VALUES ('ct-run', 'chronotranscriber', 'x')");
		// As ChronoTranscriber's forced replacement and ChronoMiner's reset_units do: status and run_id change, the
		// tool column stays.
		connection.run(
			"UPDATE units SET status = 'pending', content = NULL, outcome = NULL, run_id = 'ct-run' WHERE idx = 1",
		);
		connection.run("UPDATE units SET stale = 1 WHERE idx = 2");
		// Page 1 as if its export never happened: the state still holds the pending row seen at the start, and
		// another tool failed that row since.
		connection.run("UPDATE units SET status = 'failed', content = NULL, run_id = 'ct-run' WHERE idx = 0");
		refreshDocument(connection, 1, "ct-run");
		connection.close();
		const statePath = join(root, ".mabillon", "scans", "run", "state.json");
		const saved = JSON.parse(readFileSync(statePath, "utf8"));
		expect(saved.units[0].storeRow).toMatchObject({ status: "done", stale: 0 });
		saved.units[0].storeRow = { status: "pending", stale: 0, runId: "mabillon-start" };
		writeFileSync(statePath, JSON.stringify(saved));
		const worked: string[] = [];
		const inner = transcriber();
		const second = await (
			await harness((context) => {
				const unit = currentUnit(context);
				if (unit && !worked.includes(unit)) worked.push(unit);
				return inner(context);
			}, {})
		).run("transcribe", [folder]);
		expect(second.documents[0]).toMatchObject({ committed: 3, pending: 0 });
		expect(worked).toEqual(["p0001", "p0002", "p0003"]);
		expect(query(database, "SELECT status, stale FROM units ORDER BY idx")).toEqual([
			{ status: "done", stale: 0 },
			{ status: "done", stale: 0 },
			{ status: "done", stale: 0 },
		]);
		expect(String(query(database, "SELECT run_id FROM units WHERE idx = 1")[0].run_id)).not.toBe("ct-run");
	}, 120_000);

	it("keeps the working folders of mirrored image folders apart and --force from replacing another source", async () => {
		const root = tempDir();
		const a = await makeImageFolder(join(root, "in", "A", "scan"), 1);
		const b = await makeImageFolder(join(root, "in", "B", "scan"), 1);
		const schema = writePriceSchema(root);
		const out = join(root, "out");
		const mirror = await harness(extractor(), { schema, out, layout: "mirror" });
		expect((await mirror.run("extract", [join(root, "in")])).documents.map((doc) => doc.error)).toEqual([
			undefined,
			undefined,
		]);
		for (const side of ["A", "B"]) {
			expect(existsSync(join(realPath(out), ".mabillon", side, "scan_output", "run", "state.json"))).toBe(true);
		}
		const flat = join(root, "flat");
		expect((await (await harness(extractor(), { schema, out: flat })).run("extract", [a])).documents[0].error).toBe(
			undefined,
		);
		const forced = await (await harness(extractor(), { schema, out: flat, force: true })).run("extract", [b]);
		expect(forced.documents[0].error).toMatch(/holds the run of .*--force does not replace it/);
		expect(existsSync(join(realPath(flat), ".mabillon", "scan_output", "run", "state.json"))).toBe(true);
	}, 120_000);

	it("renders the files of a folder with a multi-page TIFF without a store row, and refuses it for ChronoMiner", async () => {
		const root = tempDir();
		mkdirSync(join(root, "scan"));
		const page = () =>
			sharp({ create: { width: 200, height: 300, channels: 3, background: "#f4ecd8" } })
				.png()
				.toBuffer();
		await sharp([await page(), await page()], { join: { animated: true } })
			.tiff()
			.toFile(join(root, "scan", "pages.tif"));
		const transcribed = await (await harness(transcriber(), {})).run("transcribe", [join(root, "scan")]);
		expect(transcribed.documents[0]).toMatchObject({ committed: 2 });
		expect(transcribed.documents[0].error).toBeUndefined();
		expect(readFileSync(join(root, "scan.txt"), "utf8")).toMatch(/Take ſpinage for p0002/);
		expect(existsSync(join(root, "chronotranscriber.sqlite"))).toBe(false);
		const worked: string[] = [];
		const inner = extractor();
		const h = await harness(
			(context) => {
				worked.push("call");
				return inner(context);
			},
			{ schema: writePriceSchema(root) },
		);
		const extracted = await h.run("extract", [join(root, "scan")]);
		expect(extracted.documents[0].error).toMatch(/pages\.tif has 2 pages .*split it/);
		expect(worked).toEqual([]);
		// Files a store document registered are not replaced by such a rendering, also not under --force.
		const other = tempDir();
		const folder = await makeImageFolder(join(other, "scan"), 1);
		expect((await (await harness(transcriber(), {})).run("transcribe", [folder])).documents[0].error).toBeUndefined();
		rmSync(join(folder, "scan_1.png"));
		rmSync(join(other, ".mabillon"), { recursive: true, force: true });
		writeFileSync(join(folder, "pages.tif"), readFileSync(join(root, "scan", "pages.tif")));
		const before = readFileSync(join(other, "scan.txt"), "utf8");
		const refused = await (await harness(transcriber(), { force: true })).run("transcribe", [folder]);
		expect(refused.documents[0].error).toMatch(/scan\.txt is a rendered file of the store document 'scan'/);
		expect(readFileSync(join(other, "scan.txt"), "utf8")).toBe(before);
		// Nor by the files of a single image whose name another document's file has (book.jpg beside book.pdf).
		const pdf = makePdf(join(other, "book.pdf"), ["Pepper 3 fl"]);
		expect(
			(await (await harness(transcriber(), { dpi: 72 })).run("transcribe", [pdf])).documents[0].error,
		).toBeUndefined();
		const book = readFileSync(join(other, "book.txt"), "utf8");
		rmSync(join(other, ".mabillon"), { recursive: true, force: true });
		writeFileSync(
			join(other, "book.jpg"),
			await sharp({ create: { width: 200, height: 300, channels: 3, background: "#ffffff" } })
				.jpeg()
				.toBuffer(),
		);
		const image = await (await harness(transcriber(), { force: true })).run("transcribe", [join(other, "book.jpg")]);
		expect(image.documents[0].error).toMatch(/book\.txt is a rendered file of the store document 'book'/);
		expect(readFileSync(join(other, "book.txt"), "utf8")).toBe(book);
	}, 120_000);

	it("refuses inputs that cannot become ChronoMiner or ChronoTranscriber documents", async () => {
		const root = tempDir();
		const schema = writePriceSchema(root);
		const h = await harness(extractor(), { schema, chunkTokens: 100 });
		// Two images of one folder whose ChronoMiner documents share a name.
		const folder = await makeImageFolder(join(root, "ledger"), 1);
		writeFileSync(join(folder, "scan_1.jpg"), readFileSync(join(folder, "scan_1.png")));
		await expect(h.run("extract", [folder])).rejects.toThrow(/scan_1\.(png|jpg) and .*scan_1\.(png|jpg) would share/);
		// A page of ChronoTranscriber's page list that Mabillon cannot decode.
		const bmp = await makeImageFolder(join(root, "bmp"), 1);
		writeFileSync(join(bmp, "extra.bmp"), "BM");
		const refused = await h.run("extract", [bmp]);
		expect(refused.documents[0].error).toMatch(/extra\.bmp is a page .* cannot decode/);
		expect(existsSync(join(root, "bmp_output.mabillon.json"))).toBe(false);
		// A line longer than four chunks.
		const long = join(root, "long.txt");
		writeFileSync(long, `${"x".repeat(2000)}\n`);
		expect((await h.run("extract", [long])).documents[0].error).toMatch(/line 1 has 2,000 characters/);
		// The state of a run before 0.10.0.
		const notes = join(root, "old", "notes.txt");
		mkdirSync(join(root, "old", "chronoagent_output", "notes", "run"), { recursive: true });
		writeFileSync(join(root, "old", "chronoagent_output", "notes", "run", "state.json"), "{}");
		writeFileSync(notes, "Pepper.\n");
		expect((await h.run("extract", [notes])).documents[0].error).toMatch(
			/chronoagent_output.notes holds a run of Mabillon before 0\.10\.0/,
		);
	}, 120_000);
});

/** A store document as ChronoTranscriber writes it: run, document and units of tool chronotranscriber. */
function writeCtDocument(
	root: string,
	name: string,
	input: string,
	units: Array<{ status: string; content: string | null; label: string }>,
) {
	const store = ChronoStore.open(root, "chronotranscriber", { command: "x", toolVersion: "0", spec: {} });
	store.close(undefined);
	const connection = new Connection(join(root, "chronotranscriber.sqlite"));
	try {
		connection.transaction((c) => {
			c.run(
				"INSERT INTO runs (run_id, tool, tool_version, command, started_at) VALUES ('ct-run', 'chronotranscriber', '1.3.1', 'transcribe', '2026-11-01T00:00:00.000+00:00')",
			);
			c.run(
				"INSERT INTO documents (doc_id, name, tool, input_path, input_sha256, kind, first_run_id, last_run_id) VALUES (1, ?, 'chronotranscriber', ?, ?, 'images', 'ct-run', 'ct-run')",
				name,
				input,
				inputIdentity(input),
			);
			units.forEach((unit, idx) => {
				c.run(
					"INSERT INTO units (doc_id, kind, idx, status, outcome, source_index, label, content, tool, model, provider, run_id, attempts, updated_at) VALUES (1, 'page', ?, ?, ?, ?, ?, ?, 'chronotranscriber', 'gpt-6-luna', 'openai', 'ct-run', 1, '2026-11-01T00:00:00.000+00:00')",
					idx,
					unit.status,
					unit.status === "done" ? "ok" : unit.status === "failed" ? "failed" : null,
					unit.label,
					unit.label,
					unit.content,
				);
			});
			refreshDocument(c, 1, "ct-run");
		});
	} finally {
		connection.close();
	}
}

describe("mixed stores and refusals", () => {
	it("adopts the done pages another tool stored and works only the others", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 3);
		const label = (n: number) => `scan_${n}.png_pre_processed.jpg`;
		writeCtDocument(realPath(root), "scans", realPath(folder), [
			{ status: "done", content: "Text by ChronoTranscriber.", label: label(1) },
			{ status: "failed", content: "[transcription error: x]", label: label(2) },
			{ status: "pending", content: null, label: label(3) },
		]);
		const worked: string[] = [];
		const inner = transcriber();
		const h = await harness((context) => {
			const unit = currentUnit(context);
			if (unit && !worked.includes(unit)) worked.push(unit);
			return inner(context);
		}, {});
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0]).toMatchObject({ committed: 3, pending: 0 });
		expect(worked).toEqual(["p0002", "p0003"]);
		const database = join(realPath(root), "chronotranscriber.sqlite");
		const units = query(database, "SELECT status, tool, content, run_id FROM units ORDER BY idx");
		expect(units[0]).toEqual({
			status: "done",
			tool: "chronotranscriber",
			content: "Text by ChronoTranscriber.",
			run_id: "ct-run",
		});
		expect(units.slice(1).map((unit) => unit.tool)).toEqual(["mabillon", "mabillon"]);
		expect(readFileSync(join(root, "scans.txt"), "utf8").startsWith("Text by ChronoTranscriber.\n")).toBe(true);
		const sidecar = readSidecar(root, "scans");
		expect(sidecar.pages[0].adopted_from).toEqual({ tool: "chronotranscriber", run_id: "ct-run" });
		// The default schema requires image_analysis, which the store has no value for.
		expect(sidecar.pages[0]).toMatchObject({ image_analysis: "", transcription: "Text by ChronoTranscriber." });
		expect(sidecar.pages[0].issues).toBeUndefined();
		expect(sidecar.mabillon.units_adopted).toBe(1);
	}, 120_000);

	it("refuses a store document of another input, a newer store and shared outputs before any agent work", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 1);
		const other = await makeImageFolder(join(root, "elsewhere", "scans"), 2);
		writeCtDocument(realPath(root), "scans", realPath(other), [
			{ status: "done", content: "Other.", label: "scan_1.png_pre_processed.jpg" },
		]);
		const h = await harness(transcriber(), {});
		const refused = await h.run("transcribe", [folder]);
		expect(refused.documents[0].error).toMatch(/holds another input .*use --force/);
		expect(query(join(realPath(root), "chronotranscriber.sqlite"), "SELECT tool FROM units")).toEqual([
			{ tool: "chronotranscriber" },
		]);
		// A store at another schema version is refused (exit 2) before any document is touched.
		const newer = tempDir();
		const pdf = makePdf(join(newer, "a.pdf"), ["x"]);
		const store = ChronoStore.open(realPath(newer), "chronotranscriber", {
			command: "x",
			toolVersion: "0",
			spec: {},
		});
		store.close(undefined);
		const connection = new Connection(join(realPath(newer), "chronotranscriber.sqlite"));
		connection.run("UPDATE meta SET version = 4 WHERE component = 'chronotranscriber'");
		connection.close();
		await expect(h.run("transcribe", [pdf])).rejects.toThrow(/carries schema versions .*chronotranscriber 4/);
		// Two inputs whose outputs differ only in case would share a store document.
		const shared = tempDir();
		makePdf(join(shared, "Book.pdf"), ["x"]);
		mkdirSync(join(shared, "sub"));
		makePdf(join(shared, "sub", "book.pdf"), ["y"]);
		const flat = await harness(extractor(), { out: join(shared, "out"), schema: writePriceSchema(shared) });
		await expect(flat.run("extract", [join(shared, "Book.pdf"), join(shared, "sub", "book.pdf")])).rejects.toThrow(
			/would share the output book/,
		);
		expect(existsSync(join(shared, "out"))).toBe(false);
	}, 120_000);

	it("keeps a rendered file edited by hand unless --force, and refuses a document another run leases", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 1);
		const first = await (await harness(transcriber(), {})).run("transcribe", [folder]);
		expect(first.documents[0].committed).toBe(1);
		const txt = join(root, "scans.txt");
		writeFileSync(txt, "edited by hand\n");
		const second = await (await harness(transcriber(), {})).run("transcribe", [folder]);
		expect(second.documents[0].warnings?.some((warning) => /changed outside the tool/.test(warning))).toBe(true);
		// The kept file makes the export incomplete.
		expect(second.documents[0].error).toMatch(/rendered files are not current: kept .*scans\.txt/);
		expect(readFileSync(txt, "utf8")).toBe("edited by hand\n");
		const forced = await (await harness(transcriber(), { force: true })).run("transcribe", [folder]);
		expect(forced.documents[0].committed).toBe(1);
		expect(readFileSync(txt, "utf8")).not.toBe("edited by hand\n");
		// A live lease blocks the document, also one of another Mabillon run (and --force deletes nothing then);
		// an expired lease is taken over.
		const database = join(realPath(root), "chronotranscriber.sqlite");
		const connection = new Connection(database);
		const until = Date.now() / 1000 + LEASE_TTL;
		connection.run("INSERT INTO runs (run_id, tool, started_at) VALUES ('ct-live', 'chronotranscriber', 'x')");
		connection.run("UPDATE documents SET lease_run_id = 'ct-live', lease_until = ?", until);
		const blocked = await (await harness(transcriber(), { redoReview: true })).run("transcribe", [folder]);
		expect(blocked.documents[0].error).toMatch(/is leased by run ct-live/);
		const mabillonRun = String(query(database, "SELECT run_id FROM runs WHERE tool = 'mabillon' LIMIT 1")[0].run_id);
		connection.run("UPDATE documents SET lease_run_id = ?, lease_until = ?", mabillonRun, until);
		const state = join(root, ".mabillon", "scans", "run", "state.json");
		const before = readFileSync(state, "utf8");
		const live = await (await harness(transcriber(), { force: true })).run("transcribe", [folder]);
		expect(live.documents[0].error).toMatch(new RegExp(`is leased by run ${mabillonRun}`));
		expect(readFileSync(state, "utf8")).toBe(before);
		connection.run("UPDATE documents SET lease_until = ?", Date.now() / 1000 - 1);
		connection.close();
		const resumed = await (await harness(transcriber(), {})).run("transcribe", [folder]);
		expect(resumed.documents[0].error).toBeUndefined();
		expect(query(database, "SELECT lease_run_id FROM documents")[0].lease_run_id).toBeNull();
	}, 120_000);

	it("replaces the chunks of a ChronoMiner document only under --force when the chunking changed", async () => {
		const root = tempDir();
		const text = join(root, "prices.md");
		writeFileSync(text, `${RECIPES_TEXT}\n`);
		const schema = writePriceSchema(root);
		const first = await (await harness(extractor(), { schema, chunkTokens: 100 })).run("extract", [text]);
		expect(first.documents[0].pending).toBe(0);
		const database = join(realPath(root), "chronominer.sqlite");
		const connection = new Connection(database);
		connection.run(
			"INSERT INTO chunk_decisions (doc_id, idx, probability, question_sha256, model, fingerprint, created_at) VALUES (1, 0, 0.9, 'q', 'm', 'f', 'x')",
		);
		connection.close();
		// The state is gone (a fresh working folder) and the chunking differs: the stored layout is refused.
		rmSync(join(realPath(root), ".mabillon"), { recursive: true, force: true });
		const refused = await (await harness(extractor(), { schema, chunkTokens: 400 })).run("extract", [text]);
		expect(refused.documents[0].error).toMatch(/cut with other line ranges .*use --force/);
		const forced = await (await harness(extractor(), { schema, chunkTokens: 400, force: true })).run("extract", [
			text,
		]);
		expect(forced.documents[0].pending).toBe(0);
		const units = query(database, "SELECT count(*) AS n FROM units")[0].n;
		expect(units).toBe(forced.documents[0].units);
		expect(query(database, "SELECT count(*) AS n FROM chunk_decisions")[0].n).toBe(0);
		expect(query(database, "SELECT count(*) AS n FROM entries")[0].n).toBe(units);
	}, 120_000);

	it("keeps node:sqlite's experimental warning out of the output of --json", () => {
		const root = tempDir();
		const pdf = makePdf(join(root, "a.pdf"), ["x"]);
		mkdirSync(join(root, "out"));
		writeFileSync(join(root, "out", "chronotranscriber.sqlite"), "not a database at all, but long enough".repeat(30));
		const result = spawnSync(
			process.execPath,
			[join(process.cwd(), "src", "bin.ts"), "transcribe", pdf, "--out", join(root, "out"), "--json"],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exit_code: 2 });
		expect(result.stderr).not.toMatch(/ExperimentalWarning/);
	}, 60_000);
});
