import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
	workingDir,
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
	const config = mergeConfig({
		model: "faux/faux-1",
		autoContext: false,
		settleRetries: 0,
		chrono: true,
		...overrides,
	});
	const logs: string[] = [];
	return {
		logs,
		requests: faux.requests,
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

/** What the model was shown: the system prompt and, per unit, the text of the user messages that named it. */
function shown(requests: TranscriptContext[]): { system: string; units: Record<string, string> } {
	// A unit is delivered in a user message or in the result of the commit before it.
	const units: Record<string, string> = {};
	const seen = new Set<string>();
	for (const request of requests) {
		for (const message of request.messages) {
			if (message.role !== "user" && message.role !== "toolResult") continue;
			const text = messageText(message);
			const unit = [...text.matchAll(/Current unit: ([pc]\d+)/g)].pop()?.[1];
			if (!unit || seen.has(text)) continue;
			seen.add(text);
			units[unit] = `${units[unit] ?? ""}\n${text}`;
		}
	}
	return { system: JSON.stringify(requests[0] ?? {}), units };
}

const DRAFT_NOTE = /holds (a transcription|an extraction) of this (page|chunk) that contains errors/;

describe("correction mode", () => {
	it("corrects the pages ChronoTranscriber transcribed of an image folder, from another store", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "in", "scans"), 5);
		const drafts = join(root, "drafts");
		mkdirSync(drafts);
		writeCtDocument(realPath(drafts), "scans", realPath(folder), [
			{ status: "done", content: "Take spinach, errrors here.", label: "scan_1.png_pre_processed.jpg" },
			// Not seeded: marked stale, of another image, without an image name, empty (with a warning).
			{ status: "done", content: "Stale page.", label: "scan_2.png_pre_processed.jpg", stale: 1 },
			{ status: "done", content: "Not this folder's page.", label: "scan_9.png_pre_processed.jpg" },
			{ status: "done", content: "No image name.", label: null, sourceIndex: 3 },
			{ status: "done", content: "  ", label: "scan_5.png_pre_processed.jpg" },
		]);
		const database = join(realPath(drafts), "chronotranscriber.sqlite");
		const before = readFileSync(database);
		const out = join(root, "out");
		let seeded = "";
		const inner = transcriber();
		const h = await harness(
			(context) => {
				const unit = currentUnit(context);
				if (unit === "p0001" && !seeded) {
					seeded = readFileSync(join(workingDir(out, "scans"), "work", "units", "p0001.md"), "utf8");
				}
				return inner(context);
			},
			{ out, drafts },
		);
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0]).toMatchObject({ committed: 5, pending: 0 });
		expect(summary.documents[0].warnings?.some((warning) => /p0005: the draft is empty/.test(warning))).toBe(true);
		// The seeded file: the schema's front matter (required fields empty) and the stored text as its body.
		expect(seeded).toMatch(/^---\n[\s\S]*image_analysis: ""[\s\S]*---\nTake spinach, errrors here\.\n$/);
		const { system, units } = shown(h.requests);
		expect(system).toContain("correct an erroneous transcription of each page");
		expect(system).toContain("Unless the unit message says otherwise");
		expect(units.p0001).toMatch(DRAFT_NOTE);
		expect(units.p0001).not.toContain("errrors");
		for (const unit of ["p0002", "p0003", "p0004", "p0005"]) {
			expect(units[unit]).not.toMatch(DRAFT_NOTE);
			expect(units[unit]).toContain("There is no draft for this unit");
		}
		const state = JSON.parse(readFileSync(join(workingDir(out, "scans"), "run", "state.json"), "utf8"));
		expect(state.units[0].draft).toMatchObject({
			store: database,
			document: "scans",
			tool: "chronotranscriber",
			runId: "ct-run",
		});
		expect(state.units[0].draft.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(state.units.slice(1).map((unit: { draft?: unknown }) => unit.draft)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
		expect(state.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/p0005: the draft is empty/)]));
		expect(state.experiment.settings.correction).toBe(true);
		expect(readSidecar(out, "scans").pages[0].draft).toMatchObject({ document: "scans", run_id: "ct-run" });
		// The drafts store is read, never written; the seeded draft keeps an immutable copy in run/drafts/.
		expect(readFileSync(database).equals(before)).toBe(true);
		expect(readFileSync(join(workingDir(out, "scans"), "run", "drafts", "units", "p0001.md"), "utf8")).toBe(seeded);
		// Another tool replaces the corrected page's row in the output store: the resume corrects it again from its
		// draft instead of adopting that row.
		const output = new Connection(join(realPath(out), "chronotranscriber.sqlite"));
		output.run("INSERT INTO runs (run_id, tool, started_at) VALUES ('ct-later', 'chronotranscriber', 'x')");
		output.run(
			"UPDATE units SET tool = 'chronotranscriber', run_id = 'ct-later', content = 'Later text.' WHERE idx = 0",
		);
		output.close();
		const again: string[] = [];
		const resumed = await (
			await harness(
				(context) => {
					const unit = currentUnit(context);
					if (unit && !again.includes(unit)) again.push(unit);
					return inner(context);
				},
				{ out, drafts },
			)
		).run("transcribe", [folder]);
		expect(resumed.documents[0]).toMatchObject({ committed: 5, pending: 0 });
		expect(again).toEqual(["p0001"]);
		const resumedState = JSON.parse(readFileSync(join(workingDir(out, "scans"), "run", "state.json"), "utf8"));
		expect(resumedState.units[0].adopted).toBeUndefined();
		expect(query(join(realPath(out), "chronotranscriber.sqlite"), "SELECT tool FROM units WHERE idx = 0")).toEqual([
			{ tool: "mabillon" },
		]);
	}, 120_000);

	it("corrects a PDF in place, replacing the drafted rows, and refuses ambiguous or changed drafts", async () => {
		const dir = scenarioDir("ct-correct-inplace");
		mkdirSync(join(dir, "in"), { recursive: true });
		const pdf = makePdf(join(dir, "in", "receipts.pdf"), ["First page", "Second page"]);
		const root = realPath(join(dir, "in"));
		const page = (n: number) => ({
			status: "done",
			content: `Draft of page ${n}.`,
			label: `page_000${n}_pre_processed.jpg`,
			sourceIndex: n - 1,
		});
		writeCtDocument(root, "receipts", realPath(pdf), [page(1), page(2)], { kind: "pdf" });
		const worked: string[] = [];
		// The correction of page 2 is closed for review.
		const inner = transcriber({ stop: ["p0002"] });
		const h = await harness(
			(context) => {
				const unit = currentUnit(context);
				if (unit && !worked.includes(unit)) worked.push(unit);
				return inner(context);
			},
			{ drafts: root, dpi: 72 },
		);
		const summary = await h.run("transcribe", [pdf]);
		expect(summary.documents[0]).toMatchObject({ committed: 1, needsReview: 1, pending: 0 });
		// The drafted pages are worked, not adopted. The committed correction replaces its row; the failed one
		// leaves the stored draft as it was, and is reported in the sidecar only.
		expect(worked).toEqual(["p0001", "p0002"]);
		const database = join(root, "chronotranscriber.sqlite");
		expect(query(database, "SELECT tool, status, content FROM units ORDER BY idx")).toEqual([
			{ tool: "mabillon", status: "done", content: expect.stringContaining("Take ſpinage for p0001") },
			{ tool: "chronotranscriber", status: "done", content: "Draft of page 2." },
		]);
		expect(readSidecar(root, "receipts").pages[1]).toMatchObject({ status: "needs_review" });
		// --force would reset the drafts of the output store before the correction.
		await expect(
			(await harness(transcriber(), { drafts: root, dpi: 72, force: true })).run("transcribe", [pdf]),
		).rejects.toThrow(/--force would reset the drafts .*drop the documents/);
		expect(readSidecar(root, "receipts").mabillon.units_adopted ?? 0).toBe(0);
		describeScenario(dir, {
			tool: "chronotranscriber",
			mode: "transcribe",
			input: realPath(pdf),
			output: null,
			formats: ["txt"],
			expect: { receipts: "complete" },
		});
		// Two documents of the same input need --drafts-document; a document of another version is refused.
		const other = tempDir();
		const twice = join(other, "drafts");
		mkdirSync(twice);
		writeCtDocument(realPath(twice), "receipts", realPath(pdf), [page(1)], { kind: "pdf" });
		writeCtDocument(realPath(twice), "copy", realPath(pdf), [page(1)], { kind: "pdf", docId: 2 });
		const ambiguous = await (await harness(transcriber(), { out: join(other, "a"), drafts: twice, dpi: 72 })).run(
			"transcribe",
			[pdf],
		);
		expect(ambiguous.documents[0].error).toMatch(
			/several documents .*: copy, receipts; choose one with --drafts-document/,
		);
		const chosen = await (
			await harness(transcriber(), { out: join(other, "b"), drafts: twice, draftsDocument: "copy", dpi: 72 })
		).run("transcribe", [pdf]);
		expect(chosen.documents[0].error).toBeUndefined();
		const stale = join(other, "stale");
		mkdirSync(stale);
		writeCtDocument(realPath(stale), "receipts", realPath(pdf), [page(1)], { kind: "pdf", sha256: "0".repeat(64) });
		const changed = await (await harness(transcriber(), { out: join(other, "c"), drafts: stale, dpi: 72 })).run(
			"transcribe",
			[pdf],
		);
		expect(changed.documents[0].error).toMatch(/was made from another version of/);
		// ChronoTranscriber's native PDF text has no pages to seed.
		const native = join(other, "native");
		mkdirSync(native);
		writeCtDocument(realPath(native), "receipts", realPath(pdf), [page(1)], { kind: "pdf", unitKind: "text" });
		const refused = await (await harness(transcriber(), { out: join(other, "d"), drafts: native, dpi: 72 })).run(
			"transcribe",
			[pdf],
		);
		expect(refused.documents[0].error).toMatch(/native PDF text .*cannot seed pages/);
		const extract = await harness(extractor(), { drafts: twice, schema: writePriceSchema(other) });
		await expect(extract.run("extract", [pdf])).rejects.toThrow(
			/extract takes its drafts from a chronominer\.sqlite/,
		);
	}, 120_000);

	it("keeps the stored rows of unmatched and failed corrections, and corrects a changed row again from its draft", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 2);
		writeCtDocument(realPath(root), "scans", realPath(folder), [
			{ status: "done", content: "Page without an image name.", label: null, sourceIndex: 0 },
			{ status: "done", content: "Draft of scan 2.", label: "scan_2.png_pre_processed.jpg" },
		]);
		const database = join(realPath(root), "chronotranscriber.sqlite");
		const worked: string[] = [];
		const record = (inner: (context: TranscriptContext) => AssistantMessage) => (context: TranscriptContext) => {
			const unit = currentUnit(context);
			if (unit && !worked.includes(unit)) worked.push(unit);
			return inner(context);
		};
		// Both attempts are closed for review: the unmatched page is worked from scratch, not adopted, and neither
		// stored row is replaced.
		const first = await (
			await harness(record(transcriber({ stop: ["p0001", "p0002"] })), { drafts: root, settleRetries: 0 })
		).run("transcribe", [folder]);
		expect(first.documents[0]).toMatchObject({ committed: 0, needsReview: 2 });
		expect(worked).toEqual(["p0001", "p0002"]);
		expect(
			first.documents[0].warnings?.some((warning) =>
				/p0001: the stored page does not name scan_1\.png/.test(warning),
			),
		).toBe(true);
		expect(query(database, "SELECT tool, content FROM units ORDER BY idx")).toEqual([
			{ tool: "chronotranscriber", content: "Page without an image name." },
			{ tool: "chronotranscriber", content: "Draft of scan 2." },
		]);
		// Another tool changes page 2; --redo-review corrects it again from the saved draft.
		const connection = new Connection(database);
		connection.run("INSERT INTO runs (run_id, tool, started_at) VALUES ('ct-later', 'chronotranscriber', 'x')");
		connection.run("UPDATE units SET run_id = 'ct-later', content = 'Later text.' WHERE idx = 1");
		connection.close();
		const h = await harness(record(transcriber()), { drafts: root, redoReview: true });
		const second = await h.run("transcribe", [folder]);
		expect(second.documents[0]).toMatchObject({ committed: 2, pending: 0 });
		expect(shown(h.requests).units.p0002).toMatch(DRAFT_NOTE);
		expect(query(database, "SELECT tool FROM units ORDER BY idx")).toEqual([
			{ tool: "mabillon" },
			{ tool: "mabillon" },
		]);
	}, 120_000);

	it("takes ChronoMiner's chunk ranges as the units of a text and corrects them in place", async () => {
		const dir = scenarioDir("cm-correct-ranges");
		mkdirSync(join(dir, "in"), { recursive: true });
		const text = join(dir, "in", "prices.md");
		// The trailing blank line is line 40 for ChronoMiner, and its last chunk ends there.
		writeFileSync(text, `${RECIPES_TEXT}\n\n`);
		const root = realPath(join(dir, "in"));
		const answer = (n: number) =>
			JSON.stringify({
				contains_no_content_of_requested_type: false,
				entries: [{ item: `Pepper ${n}`, price: { amount: n, currency: "fl" }, tags: [], page: 1, checked: false }],
			});
		const ranges = ["1-10", "11-25", "26-40"];
		writeStoreDocument(
			"chronominer",
			root,
			"prices",
			realPath(text),
			[
				{ status: "done", content: answer(1), label: ranges[0] },
				{ status: "done", content: "not a JSON answer", label: ranges[1] },
				{ status: "done", content: answer(3), label: ranges[2] },
			],
			{ kind: "text", sha256: null },
		);
		const schema = writePriceSchema(dir);
		const h = await harness(extractor(), { drafts: root, schema, chunkTokens: 100, formats: ["json", "csv"] });
		const summary = await h.run("extract", [text]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc).toMatchObject({ units: 3, committed: 3 });
		expect(doc.warnings?.some((warning) => /records no input hash/.test(warning))).toBe(true);
		expect(doc.warnings?.some((warning) => /c0002: the draft is no JSON object/.test(warning))).toBe(true);
		const { system, units } = shown(h.requests);
		expect(system).toContain("correct an erroneous extraction of each chunk");
		expect(Object.keys(units)).toEqual(["c0001", "c0002", "c0003"]);
		expect(units.c0001).toMatch(DRAFT_NOTE);
		expect(units.c0002).not.toMatch(DRAFT_NOTE);
		const database = join(root, "chronominer.sqlite");
		expect(query(database, "SELECT source_index, tool FROM units ORDER BY idx")).toEqual(
			ranges.map((range) => ({ source_index: range, tool: "mabillon" })),
		);
		const meta = JSON.parse(readFileSync(join(root, "prices_output.json"), "utf8"))._chronominer_metadata;
		expect(meta.chunking_method).toBe("line_ranges");
		describeScenario(dir, {
			tool: "chronominer",
			mode: "extract",
			input: realPath(text),
			output: root,
			schema,
			formats: ["json", "csv"],
			expect: { prices: "complete" },
		});
		// A chunk range the text cannot hold is refused, not clipped.
		const short = join(dir, "short");
		mkdirSync(short);
		const shortText = join(short, "prices.md");
		writeFileSync(shortText, "One line.\n");
		writeStoreDocument(
			"chronominer",
			realPath(short),
			"prices",
			realPath(shortText),
			[{ status: "done", content: answer(1), label: "1-2" }],
			{ kind: "text" },
		);
		const clipped = await (await harness(extractor(), { drafts: short, schema, out: join(dir, "short-out") })).run(
			"extract",
			[shortText],
		);
		expect(clipped.documents[0].error).toMatch(/chunk 1-2 lies outside the 1 lines of prices\.md/);
	}, 120_000);

	it("seeds the pages of an image folder from ChronoMiner's documents of its images", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "in", "ledger"), 3);
		const drafts = join(root, "drafts");
		mkdirSync(drafts);
		const answer = (item: string) =>
			JSON.stringify({
				contains_no_content_of_requested_type: false,
				entries: [{ item, price: { amount: 1, currency: "fl" }, tags: [], page: 1, checked: false }],
			});
		const image = (n: number) => join(realPath(folder), `scan_${n}.png`);
		const chunk = (item: string, n: number) => [
			{ status: "done", content: answer(item), label: `scan_${n}.png`, sourceIndex: `scan_${n}.png` },
		];
		// scan_1 has two documents, scan_2 one, scan_3 none.
		writeStoreDocument("chronominer", realPath(drafts), "scan_1", image(1), chunk("first", 1), { kind: "image" });
		writeStoreDocument("chronominer", realPath(drafts), "scan_1_copy", image(1), chunk("copy", 1), {
			kind: "image",
			docId: 2,
		});
		writeStoreDocument("chronominer", realPath(drafts), "scan_2", image(2), chunk("second", 2), {
			kind: "image",
			docId: 3,
		});
		const schema = writePriceSchema(root);
		const ambiguous = await (await harness(extractor(), { out: join(root, "a"), drafts, schema })).run("extract", [
			folder,
		]);
		expect(ambiguous.documents[0].error).toMatch(/several documents .*scan_1\.png: scan_1, scan_1_copy/);
		const out = join(root, "out");
		// The selector decides for scan_1 only; scan_2 keeps its own document.
		const h = await harness(extractor(), { out, drafts, schema, draftsDocument: "scan_1_copy" });
		const summary = await h.run("extract", [folder]);
		expect(summary.documents[0]).toMatchObject({ committed: 3, pending: 0 });
		const { units } = shown(h.requests);
		expect(units.p0001).toMatch(DRAFT_NOTE);
		expect(units.p0002).toMatch(DRAFT_NOTE);
		expect(units.p0003).toContain("There is no draft for this unit");
		const state = JSON.parse(readFileSync(join(workingDir(out, "ledger"), "run", "state.json"), "utf8"));
		expect(state.units.map((unit: { draft?: { document: string } }) => unit.draft?.document)).toEqual([
			"scan_1_copy",
			"scan_2",
			undefined,
		]);
		expect(state.units[0].draft).toMatchObject({ tool: "chronominer", runId: "cm-run" });
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
	units: Array<{
		status: string;
		content: string | null;
		label: string | null;
		sourceIndex?: number | string;
		stale?: number;
	}>,
	options: { docId?: number; kind?: string; sha256?: string | null; unitKind?: string } = {},
) {
	writeStoreDocument("chronotranscriber", root, name, input, units, options);
}

/** A store document as ChronoTranscriber or ChronoMiner writes it (units of kind page or chunk, run ct-run/cm-run). */
function writeStoreDocument(
	tool: "chronotranscriber" | "chronominer",
	root: string,
	name: string,
	input: string,
	units: Array<{
		status: string;
		content: string | null;
		label: string | null;
		sourceIndex?: number | string;
		stale?: number;
	}>,
	options: { docId?: number; kind?: string; sha256?: string | null; unitKind?: string } = {},
) {
	const store = ChronoStore.open(root, tool, { command: "x", toolVersion: "0", spec: {} });
	store.close(undefined);
	const connection = new Connection(join(root, `${tool}.sqlite`));
	const run = tool === "chronotranscriber" ? "ct-run" : "cm-run";
	const docId = options.docId ?? 1;
	const sha =
		options.sha256 === undefined
			? tool === "chronotranscriber"
				? inputIdentity(input)
				: fileSha(input)
			: options.sha256;
	try {
		connection.transaction((c) => {
			c.run(
				"INSERT OR IGNORE INTO runs (run_id, tool, tool_version, command, started_at) VALUES (?, ?, '1.3.1', ?, '2026-11-01T00:00:00.000+00:00')",
				run,
				tool,
				tool === "chronotranscriber" ? "transcribe" : "extract",
			);
			c.run(
				"INSERT INTO documents (doc_id, name, tool, input_path, input_sha256, kind, first_run_id, last_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				docId,
				name,
				tool,
				input,
				sha,
				options.kind ?? "images",
				run,
				run,
			);
			units.forEach((unit, idx) => {
				c.run(
					"INSERT INTO units (doc_id, kind, idx, status, outcome, source_index, label, content, tool, model, provider, run_id, attempts, stale, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'gpt-6-luna', 'openai', ?, 1, ?, '2026-11-01T00:00:00.000+00:00')",
					docId,
					options.unitKind ?? (tool === "chronotranscriber" ? "page" : "chunk"),
					idx,
					unit.status,
					unit.status === "done" ? "ok" : unit.status === "failed" ? "failed" : null,
					unit.sourceIndex ?? unit.label,
					unit.label,
					unit.content,
					tool,
					run,
					unit.stale ?? 0,
				);
			});
			refreshDocument(c, docId, run);
		});
	} finally {
		connection.close();
	}
}

function fileSha(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
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
			[join(process.cwd(), "src", "bin.ts"), "transcribe", pdf, "--out", join(root, "out"), "--chrono", "--json"],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, exit_code: 2 });
		expect(result.stderr).not.toMatch(/ExperimentalWarning/);
	}, 60_000);
});

describe("without --chrono", () => {
	it("extracts an image folder into one merged file and its CSV, without the units closed for review", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "in", "ledger"), 3);
		const out = join(root, "out");
		const schema = writePriceSchema(root);
		const extract = extractor();
		// p0002 is written but never verified, so it is closed for review with its draft.
		const responder = (context: TranscriptContext): AssistantMessage => {
			const last = context.messages[context.messages.length - 1];
			if (currentUnit(context) === "p0002" && last.role === "toolResult" && last.toolName === "write") {
				return say("Done with this page.");
			}
			return extract(context);
		};
		const h = await harness(responder, { out, schema, chrono: false, formats: ["json", "csv"] });
		const summary = await h.run("extract", [folder]);
		expect(summary.documents[0]).toMatchObject({ committed: 2, needsReview: 1 });
		expect(summary.documents[0].outputs?.json).toBe(join(realPath(out), "ledger_output.json"));
		const file = JSON.parse(readFileSync(join(out, "ledger_output.json"), "utf8"));
		expect(file.contains_no_content_of_requested_type).toBe(false);
		expect(file.entries.map((entry: { page: number }) => entry.page)).toEqual([1, 3]);
		expect(readSidecar(out, "ledger").merged.entries).toHaveLength(3);
		const csv = readFileSync(join(out, "ledger_output.csv"), "utf8").split("\n");
		expect(csv[0]).toBe("﻿item,price.amount,price.currency,tags,page,checked");
		expect(csv[1]).toBe('"Pepper, ""best"" p0001",1.5,fl,spice; unit 1,1,true');
		expect(csv).toHaveLength(4);
		expect(existsSync(join(out, "chronominer.sqlite"))).toBe(false);
		expect(existsSync(join(out, "scan_1_output.json"))).toBe(false);
	}, 120_000);

	it("resumes a run only in the setting it started with, and leaves a store's output root alone", async () => {
		const root = tempDir();
		mkdirSync(join(root, "in"), { recursive: true });
		const pdf = makePdf(join(root, "in", "book.pdf"), ["one", "two"]);
		const out = join(root, "out");
		await (await harness(transcriber(), { out, dpi: 72, chrono: false, units: "1" })).run("transcribe", [pdf]);
		const state = join(workingDir(out, "book"), "run", "state.json");
		const before = readFileSync(state);
		const resumed = await (await harness(transcriber(), { out, dpi: 72 })).run("transcribe", [pdf]);
		expect(resumed.documents[0].error).toMatch(/started without --chrono; rerun without --chrono/);
		expect(readFileSync(state)).toEqual(before);
		expect(existsSync(join(out, "chronotranscriber.sqlite"))).toBe(false);

		const stored = join(root, "stored");
		await (await harness(transcriber(), { out: stored, dpi: 72 })).run("transcribe", [pdf]);
		const standalone = await harness(transcriber(), { out: stored, dpi: 72, chrono: false });
		await expect(standalone.run("transcribe", [pdf])).rejects.toThrow(
			/holds a chronotranscriber\.sqlite; use --chrono to write into its store/,
		);
	}, 120_000);
});
