import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { DocState } from "../src/agent/state.ts";
import { type ChronoConfig, mergeConfig } from "../src/config.ts";
import { run } from "../src/driver.ts";
import {
	call,
	createFauxRuntime,
	type FauxSetup,
	makeImageFolder,
	makePdf,
	messageText,
	outputFile,
	readSidecar,
	say,
	tempDir,
	workingDir,
} from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function currentUnit(context: TranscriptContext): string | undefined {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message.role !== "user") continue;
		const match = /Current unit: ([pc]\d+)/.exec(messageText(message));
		if (match) return match[1];
	}
	return undefined;
}

function transcriptionFile(unit: string): string {
	const page = Number.parseInt(unit.slice(1), 10);
	return [
		"---",
		"image_analysis: |",
		"  Single column of roman type; page number top right.",
		"no_transcribable_text: false",
		"transcription_not_possible: false",
		"---",
		`<page_number>${page}</page_number>`,
		"To make a Tart of Hearbs.",
		"Take ſpinage and <unclear>parſley</unclear>, and boyle them.",
	].join("\n");
}

async function setup(responder: Parameters<typeof createFauxRuntime>[0], overrides: Partial<ChronoConfig>) {
	const faux: FauxSetup = await createFauxRuntime(responder);
	cleanups.push(faux.cleanup);
	const config = mergeConfig({ model: "faux/faux-1", autoContext: true, ...overrides });
	const logs: string[] = [];
	return {
		faux,
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

describe("transcription", () => {
	it("works through an image folder unit by unit, with sessions, handoff, gate and compaction", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "book"), 5);
		// Context sits beside the folder (images inside it are its pages).
		writeFileSync(join(root, "context.md"), "Seventeenth-century English cookery book, roman type.");
		const blocked: string[] = [];
		let triedForeignWrite = false;
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			const text = messageText(last);
			const unit = currentUnit(context);
			if (last.role === "user") {
				if (!unit) return say("Nothing to do.");
				if (!triedForeignWrite) {
					triedForeignWrite = true;
					return call("write", { path: "units/p0005.md", content: "too early" });
				}
				return call("write", { path: `units/${unit}.md`, content: transcriptionFile(unit) });
			}
			if (last.role === "toolResult") {
				if (last.toolName === "write" && last.isError) {
					blocked.push(text);
					return call("write", { path: `units/${unit}.md`, content: transcriptionFile(unit!) });
				}
				if (last.toolName === "write")
					return call("view", { box: { x: 0, y: 0, w: 0.5, h: 0.3 }, enhance: ["contrast"] });
				if (last.toolName === "view") return call("verify", {});
				if (last.toolName === "verify") {
					if (/Stop now/.test(text)) return say("All pages committed.");
					if (/No errors/.test(text)) return call("verify", { final: true });
					return say(`Unexpected verify result: ${text}`);
				}
			}
			return say("ok");
		};
		const harness = await setup(responder, { unitsPerSession: 2, compactAtTokens: 500, out: join(root, "out") });
		const summary = await harness.run("transcribe", [folder]);

		expect(summary.documents).toHaveLength(1);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc.committed).toBe(5);
		expect(doc.needsReview).toBe(0);
		expect(blocked[0]).toMatch(/You can only write units\/p0001\.md/);

		const out = join(root, "out");
		const state = JSON.parse(readFileSync(join(workingDir(out, "book"), "run", "state.json"), "utf8")) as DocState;
		expect(state.sessions).toHaveLength(3);
		expect(state.units.every((unit) => unit.status === "committed")).toBe(true);
		expect(state.sessions.reduce((sum, session) => sum + (session.compactions ?? 0), 0)).toBeGreaterThan(0);

		// After a compaction the model sees the deterministic state summary, not the old turns.
		const compacted = harness.faux.requests.find((request) =>
			request.messages.some((message) => /Earlier messages of this session were removed/.test(messageText(message))),
		);
		expect(compacted).toBeDefined();
		// Later sessions start with a handoff that includes the end of the previous unit.
		const handoff = harness.faux.requests.find((request) =>
			request.messages.some((message) => /Session start[\s\S]*Last lines of p0002/.test(messageText(message))),
		);
		expect(handoff).toBeDefined();
		// Context text reaches the system prompt.
		const systemText = harness.faux.requests[0].messages
			.filter((message) => message.role === "system")
			.map((message) => JSON.stringify(message))
			.join("\n");
		expect(systemText).toContain("Seventeenth-century English cookery book");

		const output = readSidecar(out, "book");
		expect(output.pages).toHaveLength(5);
		expect(output.pages[0].transcription).toContain("ſpinage");
		expect(output.mabillon.complete).toBe(true);
		// ChronoTranscriber's file: the hash layout below --out, pages joined by a newline; txt alone by default.
		const txt = outputFile(out, "book.txt");
		expect(txt).toMatch(/[\\/]book-[0-9a-f]{8}[\\/]book\.txt$/);
		const page = (n: number) =>
			`<page_number>${n}</page_number>\nTo make a Tart of Hearbs.\nTake ſpinage and <unclear>parſley</unclear>, and boyle them.`;
		expect(readFileSync(txt, "utf8")).toBe(`${[1, 2, 3, 4, 5].map(page).join("\n")}\n`);
		expect(existsSync(join(dirname(txt), "book.md"))).toBe(false);
		// Without --chrono no store is written.
		expect(output.mabillon.store).toBeUndefined();
		expect(existsSync(join(out, "chronotranscriber.sqlite"))).toBe(false);
	}, 120_000);

	it("closes a unit for review when the tool budget is exhausted", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "scans"), 2);
		const responder = () => call("view", { grid: true });
		const harness = await setup(responder, { toolSoftCap: 2, toolHardCap: 3, out: join(root, "out") });
		const summary = await harness.run("transcribe", [folder]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc.needsReview).toBe(2);
		const state = JSON.parse(
			readFileSync(join(workingDir(join(root, "out"), "scans"), "run", "state.json"), "utf8"),
		) as DocState;
		expect(state.units[0].closedReason).toMatch(/tool budget/);
		expect(state.units[0].toolCalls).toBe(4);
	}, 120_000);

	it("nudges an agent that stops early, then closes the unit for review", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "lazy"), 2);
		const responder = () => say("I have looked at the page and I am done.");
		const harness = await setup(responder, { settleRetries: 2, out: join(root, "out") });
		const summary = await harness.run("transcribe", [folder]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc.needsReview).toBe(2);
		const nudges = harness.faux.requests.filter((request) =>
			/You stopped, but p0001 is not committed/.test(messageText(request.messages[request.messages.length - 1])),
		);
		// Each unit gets a second session before it is closed; every session nudges settleRetries times.
		expect(nudges).toHaveLength(4);
		const state = JSON.parse(
			readFileSync(join(workingDir(join(root, "out"), "lazy"), "run", "state.json"), "utf8"),
		) as DocState;
		expect(state.sessions).toHaveLength(4);
		expect(state.units[0].closedReason).toBe("the agent stopped twice without committing");
	}, 120_000);

	it("renders PDF pages on demand", async () => {
		const root = tempDir();
		const pdf = makePdf(join(root, "receipts.pdf"), ["First page", "Second page"]);
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			const unit = currentUnit(context);
			if (last.role === "user" && unit)
				return call("write", { path: `units/${unit}.md`, content: transcriptionFile(unit) });
			if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
			return say("done");
		};
		const harness = await setup(responder, { out: join(root, "out"), dpi: 150 });
		const summary = await harness.run("transcribe", [pdf]);
		expect(summary.documents[0].committed).toBe(2);
		// Pages are rendered in memory and never written as lossy files.
		expect(existsSync(join(workingDir(join(root, "out"), "receipts"), "work", "source"))).toBe(false);
		const firstRequest = harness.faux.requests[0];
		const firstUser = firstRequest.messages.find((message) => message.role === "user");
		expect(messageText(firstUser)).toMatch(/Page p0001: full page; source 1275x1650 px/);
		expect(messageText(firstUser)).toContain("[image]");
	}, 120_000);
});

const RECIPE_SCHEMA = {
	name: "MiniRecipes",
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
						title_original: { type: ["string", "null"] },
						text_original: { type: "string" },
					},
					required: ["title_original", "text_original"],
					additionalProperties: false,
				},
			},
		},
		required: ["contains_no_content_of_requested_type", "entries"],
		additionalProperties: false,
	},
};

describe("extraction from text", () => {
	it("extracts entries chunk by chunk with grounding warnings, carry-over and merged outputs", async () => {
		const root = tempDir();
		const schemaDir = join(root, "schemas");
		const fs = await import("node:fs");
		fs.mkdirSync(join(schemaDir, "rules"), { recursive: true });
		writeFileSync(join(schemaDir, "mini.json"), JSON.stringify(RECIPE_SCHEMA));
		writeFileSync(
			join(schemaDir, "rules", "MiniRecipes.rules.json"),
			JSON.stringify({ verbatimFields: ["text_original", "title_original"] }),
		);
		const recipes = Array.from({ length: 6 }, (_, i) =>
			[
				`To make a Tart of Hearbs ${i + 1}.`,
				"Take ſpinage and parſley, boyle them tender, and ſeaſon them with ſugar and ſpice;",
				"then bake it in a fine paſte.",
			].join("\n"),
		);
		const textPath = join(root, "cookbook.md");
		writeFileSync(textPath, recipes.join("\n\n"));
		const carryOvers: string[] = [];
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			const text = messageText(last);
			const unit = currentUnit(context);
			if (last.role === "user" && unit) {
				const chunk = /-----\n([\s\S]*?)\n----- end of/.exec(text)?.[1] ?? "";
				const blocks = chunk.split(/\n\s*\n/).filter((block) => block.startsWith("To make"));
				const entries = blocks.map((block, index) => {
					const lines = block.split("\n");
					// The first entry of c0001 is deliberately modernized to trigger a grounding warning.
					const normalized = unit === "c0001" && index === 0;
					return {
						title_original: normalized ? "To make a tart of herbs" : lines[0],
						text_original: normalized ? "Take spinach and parsley and boil them" : block,
					};
				});
				const data = { contains_no_content_of_requested_type: entries.length === 0, entries };
				return call("write", { path: `units/${unit}.json`, content: JSON.stringify(data, null, 2) });
			}
			if (last.role === "toolResult" && last.toolName === "write") {
				const carry = unit === "c0001" ? "nothing carried; test note" : undefined;
				if (carry) carryOvers.push(carry);
				return call("verify", carry ? { final: true, carry_over: carry } : { final: true });
			}
			return say("done");
		};
		const harness = await setup(responder, {
			schema: "MiniRecipes",
			schemasDirs: [schemaDir],
			chunkTokens: 100,
			out: join(root, "out"),
		});
		const summary = await harness.run("extract", [textPath]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc.committed).toBeGreaterThan(1);
		const out = join(root, "out");
		const docDir = workingDir(out, "cookbook");
		const state = JSON.parse(readFileSync(join(docDir, "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].issues?.some((issue) => issue.layer === "grounding")).toBe(true);
		expect(state.units[0].carryOver).toBe("nothing carried; test note");
		const provenance = readSidecar(out, "cookbook");
		const output = provenance.merged;
		expect(output.contains_no_content_of_requested_type).toBe(false);
		expect(output.entries).toHaveLength(6);
		expect(provenance.entries).toHaveLength(6);
		expect(provenance.entries[0].lines[0]).toBe(1);
		expect(provenance.mabillon.final_validation).toBeUndefined();
		// Without --chrono, _output.json is the merged object of the committed units, and no store is written.
		expect(JSON.parse(readFileSync(join(out, "cookbook_output.json"), "utf8"))).toEqual(output);
		expect(existsSync(join(out, "chronominer.sqlite"))).toBe(false);
		// Chunks start at recipe titles, and each unit shows the start of the next chunk as context.
		expect(
			state.units.every((unit) =>
				readFileSync(join(docDir, "run", "text", `${unit.id}.txt`), "utf8").startsWith("To make"),
			),
		).toBe(true);
		const first = messageText(harness.faux.requests[0].messages[harness.faux.requests[0].messages.length - 1]);
		expect(first).toContain("(Following context, start of c0002");
	}, 120_000);
});
