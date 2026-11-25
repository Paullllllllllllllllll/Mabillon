import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

describe("extraction from page images", () => {
	function writeRecipeSchema(root: string): string {
		const schemaDir = join(root, "schemas");
		mkdirSync(schemaDir, { recursive: true });
		writeFileSync(join(schemaDir, "mini.json"), JSON.stringify(RECIPE_SCHEMA));
		return schemaDir;
	}

	const recipe = (title: string) => ({ title_original: title, text_original: `${title} Take ſpinage and parſley.` });

	/**
	 * Scripted agent: on p0001 it views the pages in `views`, records one entry and commits with the verify arguments
	 * of `finals` (the next one after each refusal); p0002 gets `middle` entries, later pages one entry each. A refused
	 * verify is repeated, so an empty page is confirmed after its second look.
	 */
	function scriptedAgent(options: { views?: string[]; finals: Array<Record<string, unknown>>; middle?: object[] }) {
		const { views = [], finals, middle = [recipe("B")] } = options;
		const unitMessages = new Map<string, string>();
		const viewResults: string[] = [];
		const verifyResults: string[] = [];
		let firstVerifies = 0;
		const verify = (unit: string) =>
			call("verify", unit === "p0001" ? finals[Math.min(firstVerifies++, finals.length - 1)] : { final: true });
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			const text = messageText(last);
			const unit = currentUnit(context);
			if (!unit) return say("Nothing to do.");
			const write = (entries: object[]) =>
				call("write", {
					path: `units/${unit}.json`,
					content: JSON.stringify({ contains_no_content_of_requested_type: entries.length === 0, entries }),
				});
			if (last.role === "user") {
				unitMessages.set(unit, text);
				if (unit === "p0001") return views.length > 0 ? call("view", { unit: views[0] }) : write([recipe("A")]);
				return write(unit === "p0002" ? middle : [recipe("C")]);
			}
			if (last.role === "toolResult" && last.toolName === "view") {
				viewResults.push(text);
				const next = views[viewResults.length];
				return next ? call("view", { unit: next }) : write([recipe("A")]);
			}
			if (last.role === "toolResult" && last.toolName === "write") return verify(unit);
			if (last.role === "toolResult" && last.toolName === "verify") {
				verifyResults.push(`${unit}: ${text}`);
				if (last.isError) return verify(unit);
			}
			return say("done");
		};
		return { responder, unitMessages, viewResults, verifyResults };
	}

	async function extractPages(
		pages: number,
		agent: ReturnType<typeof scriptedAgent>,
		overrides: Partial<ChronoConfig>,
	) {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "catalogue"), pages);
		const harness = await setup(agent.responder, {
			schema: "MiniRecipes",
			schemasDirs: [writeRecipeSchema(root)],
			out: join(root, "out"),
			...overrides,
		});
		const summary = await harness.run("extract", [folder]);
		const state = JSON.parse(
			readFileSync(join(workingDir(join(root, "out"), "catalogue"), "run", "state.json"), "utf8"),
		) as DocState;
		return { harness, summary, state, sidecar: readSidecar(join(root, "out"), "catalogue") };
	}

	it("completes an entry over three pages with look_ahead 2 and passes its note to both following pages", async () => {
		const carry = "the entry ends with 'in a fine paste.'";
		const agent = scriptedAgent({
			views: ["p0002", "p0003"],
			finals: [{ final: true, carry_over: carry, carry_over_end: "p0003" }],
			middle: [],
		});
		// One unit per session: the note reaches the later pages through the handoff to a fresh session.
		const { harness, summary, state, sidecar } = await extractPages(3, agent, { lookAhead: 2, unitsPerSession: 1 });
		expect(summary.documents[0]).toMatchObject({ committed: 3, needsReview: 0 });
		expect(agent.viewResults).toHaveLength(2);
		expect(agent.viewResults.some((result) => /not available/.test(result))).toBe(false);
		// The page inside the continuation is told so; the page where it ends is told to skip that part.
		expect(agent.unitMessages.get("p0002")).toMatch(
			/Session start[\s\S]*Carry-over from p0001: an entry recorded there continues through this unit and ends in p0003 .*an entry that begins in this unit is recorded here/,
		);
		expect(agent.unitMessages.get("p0003")).toMatch(/Carry-over from p0001: .*continues into this unit/);
		const systemText = JSON.stringify(harness.faux.requests[0].messages.filter((m) => m.role === "system"));
		expect(systemText).toContain("up to 2 pages ahead");
		expect(state.units[0]).toMatchObject({ carryOver: carry, carryOverEnd: "p0003" });
		// The empty middle page goes through the second look like any other empty page.
		expect(agent.verifyResults.find((result) => result.startsWith("p0002"))).toMatch(/NOT COMMITTED: .*no entries/);
		expect(state.units[1].status).toBe("committed");
		expect(state.units[1].issues?.map((issue) => issue.message)).toContain(
			"committed without entries; confirmed by the agent after a second look",
		);
		expect(state.experiment?.settings.lookAhead).toBe(2);
		expect(sidecar.merged.entries).toHaveLength(2);
	}, 120_000);

	it("refuses a view two pages ahead by default", async () => {
		const agent = scriptedAgent({
			views: ["p0003"],
			finals: [{ final: true, carry_over: "ends with 'fine paste.'" }],
		});
		const { summary, state } = await extractPages(3, agent, {});
		expect(summary.documents[0]).toMatchObject({ committed: 3, needsReview: 0 });
		expect(agent.viewResults[0]).toContain("Page p0003 is not available. You can view: p0001, p0002.");
		expect(agent.unitMessages.get("p0003")).not.toContain("Carry-over");
		// The default is not recorded, so runs started before the setting existed keep resuming.
		expect(state.experiment?.settings).not.toHaveProperty("lookAhead");
	}, 120_000);

	it("rejects a carry_over_end beyond the look-ahead", async () => {
		const carry = "ends with 'fine paste.'";
		const agent = scriptedAgent({
			finals: [
				{ final: true, carry_over: carry, carry_over_end: "p0004" },
				{ final: true, carry_over: carry, carry_over_end: " " },
				{ final: true, carry_over: carry, carry_over_end: "p0002" },
			],
		});
		const { summary, state } = await extractPages(4, agent, { lookAhead: 2 });
		expect(summary.documents[0]).toMatchObject({ committed: 4, needsReview: 0 });
		expect(agent.verifyResults[0]).toBe(
			'p0001: Verify was not run: carry_over_end must be a later unit within reach: p0002, p0003 (not "p0004").',
		);
		expect(agent.verifyResults[1]).toBe(
			'p0001: Verify was not run: carry_over_end must be a later unit within reach: p0002, p0003 (not "").',
		);
		expect(state.units[0].carryOverEnd).toBe("p0002");
	}, 120_000);

	it.each([
		["without carry_over_end", {}],
		["with another page id in the note", { carry_over_end: "p0002" }],
	])(
		"passes the note to the next page only %s",
		async (_label, end) => {
			const agent = scriptedAgent({ finals: [{ final: true, carry_over: "ends before 'see p0003'", ...end }] });
			const { summary } = await extractPages(3, agent, { lookAhead: 2 });
			expect(summary.documents[0]).toMatchObject({ committed: 3, needsReview: 0 });
			expect(agent.unitMessages.get("p0002")).toMatch(
				/Carry-over from p0001: an entry recorded there continues into this unit/,
			);
			expect(agent.unitMessages.get("p0003")).not.toContain("Carry-over");
		},
		120_000,
	);
});
