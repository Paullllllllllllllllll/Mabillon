import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	addEntriesSetup,
	MAX_TOOL_SCHEMA_CHARS,
	PENDING_REJECTIONS_WARNING,
	resolveAddEntries,
	shiftSlot,
	updateEntry,
} from "../src/agent/add-entries.ts";
import { compactionThreshold, gatePath, normalizeToolPath } from "../src/agent/extension.ts";
import { NOTES_LIMIT, readNotes, sessionIntro, stateSummary, unitContent } from "../src/agent/messages.ts";
import {
	closingInstruction,
	coverageRefusal,
	emptyContentRefusal,
	emptyDraftRefusal,
	notInContext,
	notUtf8Error,
	rejectionList,
	softCapRefusal,
} from "../src/agent/notices.ts";
import { buildSystemPrompt } from "../src/agent/prompts.ts";
import type { SessionRuntime } from "../src/agent/runtime.ts";
import { acquireLock, type DocState, docPaths, sha256Text } from "../src/agent/state.ts";
import { cli, runExitCode } from "../src/cli.ts";
import {
	type ChronoConfig,
	checkToolSet,
	coerceConfigValue,
	DEFAULT_TOOLS,
	effectiveTools,
	mergeConfig,
	type ToolName,
} from "../src/config.ts";
import {
	classifyProviderError,
	type DocumentResult,
	fallbackProfile,
	findBashShell,
	isImageRequestError,
	run,
} from "../src/driver.ts";
import { assignStems, discoverDocuments } from "../src/inputs/discover.ts";
import { applyImageParams, resolveImageProfile, withMaxEdge } from "../src/inputs/image-profile.ts";
import { writeOutputs } from "../src/outputs.ts";
import {
	boundaryPolicy,
	envelopeInfo,
	type LoadedSchema,
	loadSchemaFile,
	resolveSchema,
} from "../src/schemas/registry.ts";
import { collectStatus } from "../src/status.ts";
import { decodeText, parseSelection } from "../src/util.ts";
import { buildGroundingSource, coverageIssues, groundingIssues } from "../src/verify/rules.ts";
import { CHUNK_COVERAGE_THRESHOLD } from "../src/verify/verify.ts";
import {
	call,
	createFauxRuntime,
	GUIDE_SCHEMA,
	loadRegisterFauxProvider,
	makeImageFolder,
	makePdf,
	messageText,
	RECIPES_SCHEMA,
	say,
	tempDir,
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

const PAGE = "---\nimage_analysis: one column\nno_transcribable_text: false\ntranscription_not_possible: false\n---\n";

/** A well-behaved agent: write the unit, commit it. */
function diligent(context: TranscriptContext): AssistantMessage {
	const last = context.messages[context.messages.length - 1];
	const unit = currentUnit(context);
	if (last.role === "user" && unit) {
		const content = unit.startsWith("p")
			? `${PAGE}Text of ${unit}`
			: JSON.stringify({ contains_no_content_of_requested_type: true, entries: [] });
		return call("write", { path: `units/${unit}.${unit.startsWith("p") ? "md" : "json"}`, content });
	}
	if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
	return say("done");
}

async function harness(
	responder: (context: TranscriptContext) => AssistantMessage,
	overrides: Partial<ChronoConfig>,
	settings: Record<string, unknown> = { retry: { enabled: false } },
) {
	const faux = await createFauxRuntime(responder);
	cleanups.push(faux.cleanup);
	const config = mergeConfig({ model: "faux/faux-1", autoContext: false, ...overrides });
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
				services: { modelRuntime: faux.modelRuntime, agentDir: faux.agentDir, settings, retryDelays: [1, 1] },
			}),
	};
}

describe("helpers", () => {
	it("classifies provider errors", () => {
		expect(classifyProviderError("401 Unauthorized: invalid x-api-key")).toBe("auth");
		expect(classifyProviderError("You exceeded your current quota")).toBe("quota");
		expect(classifyProviderError("429 Too Many Requests")).toBe("transient");
		expect(classifyProviderError("overloaded_error")).toBe("transient");
		expect(classifyProviderError("fetch failed")).toBe("transient");
		expect(classifyProviderError("something odd")).toBe("other");
		expect(classifyProviderError("terminated")).toBe("transient");
		expect(classifyProviderError("other side closed")).toBe("transient");
		expect(classifyProviderError("You have hit your ChatGPT usage limit. Try again in ~180 min.")).toBe("quota");
		expect(
			classifyProviderError(
				"429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details. Please retry in 23.5s.",
			),
		).toBe("transient");
		expect(
			classifyProviderError(
				"Rate limit reached for gpt-5.5 on tokens per min (TPM). See https://platform.openai.com/account/billing",
			),
		).toBe("transient");
		expect(classifyProviderError('502 {"detail":"Bad Gateway"}')).toBe("transient");
		expect(isImageRequestError('502 {"detail":"Bad Gateway"}')).toBe(false);
		expect(isImageRequestError('{"detail":"Unauthorized"}')).toBe(false);
		expect(
			isImageRequestError(
				"400 Invalid value: 'original'. Supported values for detail are 'low', 'high' and 'auto'.",
			),
		).toBe(true);
		expect(isImageRequestError("400 image exceeds 5 MB maximum")).toBe(true);
	});

	it("normalizes tool paths the way pi's file tools do", () => {
		expect(normalizeToolPath("@../run/state.json")).toBe("../run/state.json");
		expect(normalizeToolPath("~/.pi/agent/auth.json")).toBe(join(homedir(), ".pi/agent/auth.json"));
		// pathToFileURL gives a URL with a drive letter on Windows, which fileURLToPath requires there.
		expect(normalizeToolPath(pathToFileURL("/etc/passwd").href)).toBe(resolve("/etc/passwd"));
		expect(normalizeToolPath("units/p0001.md")).toBe("units/p0001.md");
	});

	it("keeps compaction below pi's overflow compaction, down to every boundary", () => {
		expect(compactionThreshold(250_000, 400_000)).toBe(250_000);
		expect(compactionThreshold(250_000, 200_000)).toBe(200_000 - 16_384 - 40_000);
		expect(compactionThreshold(0, 200_000)).toBe(0);
		expect(compactionThreshold(100_000, undefined)).toBe(100_000);
	});

	it("rejects invalid unit selections", () => {
		expect(() => parseSelection("0")).toThrow();
		expect(() => parseSelection("5-3")).toThrow();
		expect(() => parseSelection(",")).toThrow();
		expect(parseSelection(undefined)(7)).toBe(true);
	});

	it("finds entries behind anyOf and nullable envelopes", () => {
		const info = envelopeInfo({
			type: "object",
			$defs: { list: { type: "array", items: { type: "object" } } },
			properties: {
				contains_no_content_of_requested_type: { type: ["boolean", "null"] },
				entries: { anyOf: [{ $ref: "#/$defs/list" }, { type: "null" }] },
				source: { type: "string" },
			},
		});
		expect(info).toEqual({
			entriesField: "entries",
			emptyFlag: "contains_no_content_of_requested_type",
			otherFields: ["source"],
		});
	});

	it("decodes legacy encodings instead of producing mojibake", () => {
		expect(decodeText(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x9f])).text).toBe("Café – Ÿ");
		const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Brühe", "utf16le")]);
		expect(decodeText(utf16).text).toBe("Brühe");
		expect(decodeText(Buffer.from("Brühe", "utf16le")).text).toBe("Brühe");
		expect(decodeText(Buffer.from("﻿ſpinage", "utf8")).text).toBe("ſpinage");
	});

	it("gives colliding documents distinct output folders", () => {
		const root = tempDir();
		mkdirSync(join(root, "a"));
		mkdirSync(join(root, "b"));
		writeFileSync(join(root, "a", "book.md"), "x");
		writeFileSync(join(root, "a", "book.txt"), "x");
		writeFileSync(join(root, "b", "book.md"), "x");
		const { documents } = discoverDocuments([join(root, "a"), join(root, "b")], "extract");
		assignStems(documents, () => join(root, "out"));
		const stems = documents.map((doc) => doc.stem.toLowerCase());
		expect(new Set(stems).size).toBe(3);
	});

	it("leaves Gemini images inside function responses alone", () => {
		const gemini = resolveImageProfile(
			{ provider: "google", id: "gemini-3.1-pro", api: "google-generative-ai" },
			"max",
		);
		const request = {
			contents: [
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								name: "view",
								response: {},
								parts: [{ inlineData: { mimeType: "image/jpeg", data: "abc" } }],
							},
						},
						{ inlineData: { mimeType: "image/jpeg", data: "def" } },
					],
				},
			],
			config: {},
		};
		applyImageParams(request, gemini);
		const parts = request.contents[0].parts as Array<Record<string, unknown>>;
		expect(JSON.stringify(parts[0])).not.toContain("mediaResolution");
		expect(parts[1]).toHaveProperty("mediaResolution");
	});

	it("maps run results to exit codes", () => {
		const doc = (fields: Partial<DocumentResult>): DocumentResult => ({
			stem: "x",
			source: "x",
			outputDir: "x",
			units: 2,
			selected: 2,
			committed: 2,
			needsReview: 0,
			reviewUnits: [],
			pending: 0,
			cost: 0,
			...fields,
		});
		expect(runExitCode([doc({})], false, false)).toBe(0);
		expect(runExitCode([doc({ committed: 1, needsReview: 1 })], false, false)).toBe(3);
		expect(runExitCode([doc({ pending: 1 }), doc({ needsReview: 1 })], false, false)).toBe(1);
		expect(runExitCode([doc({ error: "x" })], false, false)).toBe(1);
		expect(runExitCode([doc({ error: "x" })], false, true)).toBe(2);
		expect(runExitCode([doc({})], true, false)).toBe(130);
		expect(runExitCode([doc({ finalValidation: ["ERROR [schema] /entries/0: bad"] })], false, false)).toBe(1);
	});

	it("compares unit gate paths the way the file system does", () => {
		expect(gatePath("Source/C0009.txt", "win32")).toBe("source/c0009.txt");
		expect(gatePath("source./c0009.txt ", "win32")).toBe("source/c0009.txt");
		expect(gatePath("Units/P0001.md", "darwin")).toBe("units/p0001.md");
		expect(gatePath("Source/c0009.txt", "linux")).toBe("Source/c0009.txt");
	});

	it("counts null as a value of its own when finding varying fields", () => {
		const root = tempDir();
		const paths = docPaths(join(root, "guide"));
		mkdirSync(paths.committedDir, { recursive: true });
		const schema = resolveSchema(GUIDE_SCHEMA, "extract", []);
		["PARIS", null].forEach((city, i) => {
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
			units: [1, 2].map((i) => ({ id: `p000${i}`, index: i, status: "committed" })),
			sessions: [],
			createdAt: "",
			updatedAt: "",
		} as unknown as DocState;
		const out = writeOutputs(paths, state, schema);
		const provenance = JSON.parse(readFileSync(out.provenance as string, "utf8"));
		expect(provenance.mabillon.varying_fields).toEqual(["active_city_or_town"]);
		expect(provenance.entries[1].unit_fields.active_city_or_town).toBeNull();
	});

	it("keeps the newest notes when notes.md is too long", () => {
		const workDir = tempDir();
		const lines = Array.from({ length: 1000 }, (_, i) => `note ${i + 1}: keep the long s as written`);
		writeFileSync(join(workDir, "notes.md"), lines.join("\n"));
		const notes = readNotes({ workDir } as SessionRuntime);
		expect(notes.length).toBeLessThanOrEqual(NOTES_LIMIT);
		expect(notes).toMatch(/^\[Earlier notes cut/);
		expect(notes).toContain("note 1000: keep");
		expect(notes).not.toContain("note 1: keep");
		// The kept part starts at a line boundary.
		expect(notes.split("\n")[1]).toMatch(/^note \d+: keep the long s as written$/);
	});

	it("takes the run lock exclusively and releases only its own lock", () => {
		const runDir = tempDir();
		const lock = join(runDir, "lock");
		const release = acquireLock(runDir);
		expect(() => acquireLock(runDir)).toThrow(/another worker of this run/);
		release();
		expect(existsSync(lock)).toBe(false);

		// A lock of a dead process on this machine is stale; one of another host is not.
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		writeFileSync(lock, JSON.stringify({ pid: deadPid, host: hostname(), startedAt: "x", token: "old" }));
		const second = acquireLock(runDir);
		second();
		writeFileSync(lock, JSON.stringify({ pid: deadPid, host: "elsewhere", startedAt: "x", token: "remote" }));
		expect(() => acquireLock(runDir)).toThrow(/pid \d+ on elsewhere/);
		rmSync(lock);

		// A lock taken over by someone else survives our release.
		const third = acquireLock(runDir);
		writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "x", token: "theirs" }));
		third();
		expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("theirs");
	});

	it("keeps the recovery guard of a paused live recoverer, however old", () => {
		const runDir = tempDir();
		const lock = join(runDir, "lock");
		const guard = `${lock}.recover`;
		const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
		const stale = JSON.stringify({ pid: deadPid, host: hostname(), startedAt: "x", token: "dead" });
		writeFileSync(lock, stale);
		let errorC: unknown;
		// A holds the guard and pauses before replacing the stale lock; its guard ages past the grace period while
		// C tries to take the same lock. C must be refused and must not touch the guard or the lock.
		const releaseA = acquireLock(runDir, {
			insideGuard: () => {
				const old = new Date(Date.now() - 3_600_000);
				utimesSync(guard, old, old);
				try {
					acquireLock(join(runDir, "."));
				} catch (error) {
					errorC = error;
				}
				expect(existsSync(guard)).toBe(true);
				expect(readFileSync(lock, "utf8")).toBe(stale);
			},
		});
		expect((errorC as Error).message).toMatch(/checking this document's lock/);
		const tokenA = JSON.parse(readFileSync(lock, "utf8")).token;
		expect(tokenA).not.toBe("dead");
		expect(existsSync(guard)).toBe(false);
		releaseA();
		// A guard whose owner on this host is dead is cleared.
		writeFileSync(lock, stale);
		writeFileSync(guard, JSON.stringify({ pid: deadPid, host: hostname(), startedAt: "x", token: "g" }));
		const release = acquireLock(runDir);
		expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
		release();
	}, 30_000);

	it("holds one lock per folder whatever the spelling of its path", () => {
		const runDir = tempDir();
		const release = acquireLock(runDir);
		const other = process.platform === "win32" || process.platform === "darwin" ? runDir.toUpperCase() : runDir;
		expect(() => acquireLock(other)).toThrow(/another worker of this run/);
		release();
		// Discovery also treats two spellings of one file as one document.
		const pdf = makePdf(join(runDir, "book.pdf"), ["Only page"]);
		const spelled = process.platform === "win32" || process.platform === "darwin" ? pdf.toUpperCase() : pdf;
		expect(discoverDocuments([pdf, spelled], "transcribe").documents).toHaveLength(1);
	});

	it("refuses a live lock of another process without touching it", () => {
		const runDir = tempDir();
		const lock = join(runDir, "lock");
		// The parent of this test process is alive and on this host.
		const live = JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: "x", token: "live" });
		writeFileSync(lock, live);
		expect(() => acquireLock(runDir)).toThrow(new RegExp(`pid ${process.ppid}`));
		expect(readFileSync(lock, "utf8")).toBe(live);
		expect(existsSync(`${lock}.recover`)).toBe(false);
	});

	it("keeps the --max-image-px cap after an image fallback", () => {
		const original = {
			...resolveImageProfile(undefined, "standard"),
			maxEdge: 6000,
			openaiDetail: "original" as const,
		};
		const capped = withMaxEdge(original, 1200);
		expect(fallbackProfile(capped, 1200)?.maxEdge).toBe(1200);
		expect(fallbackProfile(original, undefined)?.maxEdge).toBe(2048);
	});

	it("finds a per-user Git Bash and reports when there is no shell", () => {
		const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
		const perUser = "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
		const none = () => false;
		expect(findBashShell(undefined, "win32", env, (path) => path === perUser, none)).toEqual({
			available: true,
			path: perUser,
		});
		expect(findBashShell(undefined, "win32", env, none, none)).toEqual({ available: false });
		expect(findBashShell(undefined, "win32", env, none, () => true)).toEqual({ available: true });
		expect(findBashShell("D:\\missing\\bash.exe", "win32", env, none, () => true)).toEqual({ available: false });
		expect(findBashShell(undefined, "linux", {}, none, none)).toEqual({ available: true });
	});

	it("rejects verbatim fields with replacement characters the source does not have", () => {
		const schema = resolveSchema(RECIPES_SCHEMA, "extract", []);
		const data = {
			contains_no_content_of_requested_type: false,
			entries: [{ text_original: "Nimm Br�he und K�se", title_original: null }],
		};
		const lossy = groundingIssues(data, schema, buildGroundingSource("Nimm Brühe und Käse"), 0.8);
		expect(lossy.some((issue) => issue.severity === "error" && /U\+FFFD/.test(issue.message))).toBe(true);
		const damagedSource = groundingIssues(data, schema, buildGroundingSource("Nimm Br�he und K�se"), 0.8);
		expect(damagedSource.some((issue) => issue.severity === "error")).toBe(false);
	});

	it("warns when the entries cover too little of the chunk", () => {
		const schema = resolveSchema(RECIPES_SCHEMA, "extract", []);
		const recipes = [
			"To make a Tart of Hearbs. Take spinach, parsley and beets, boil them tender, chop them small and season with sugar and cinnamon.",
			"To make Fritters. Take flour, eggs and milk, beat them to a batter, put in apples sliced thin and fry them in sweet butter.",
			"To make a Sallet of Cucumbers. Pare them and slice them thin, lay them in a dish with vinegar, oil, salt and a little pepper.",
			"To make Gooseberry Fool. Scald the gooseberries until they break, strain them, sweeten with sugar and mix with thick cream.",
		];
		const chunk = recipes.join("\n\n");
		const data = (count: number) => ({
			contains_no_content_of_requested_type: false,
			entries: recipes.slice(0, count).map((text) => ({ text_original: text, title_original: null })),
		});
		const two = coverageIssues(data(2), schema, chunk, CHUNK_COVERAGE_THRESHOLD);
		expect(two).toHaveLength(1);
		expect(two[0].message).toMatch(/covers only \d+% of the chunk; check that no entry is missing/);
		expect(two[0].message).not.toContain("contains_no_content_of_requested_type");
		expect(coverageIssues(data(4), schema, chunk, CHUNK_COVERAGE_THRESHOLD)).toEqual([]);
		expect(coverageIssues(data(0), schema, chunk, CHUNK_COVERAGE_THRESHOLD)).toEqual([]);
		expect(coverageIssues(data(1), schema, recipes[0], CHUNK_COVERAGE_THRESHOLD)).toEqual([]);
	});

	it("exports every unit issue and flags damaged committed copies", () => {
		const root = tempDir();
		const paths = docPaths(join(root, "doc"));
		mkdirSync(paths.committedDir, { recursive: true });
		const schema = resolveSchema(undefined, "transcribe", []);
		const page = (text: string) => `${PAGE}${text}`;
		writeFileSync(join(paths.committedDir, "p0001.md"), page("First page"));
		writeFileSync(join(paths.committedDir, "p0002.md"), page("Changed afterwards"));
		const warning = { severity: "warning", layer: "quality", pointer: "/transcription", message: "repeated line" };
		const state = {
			version: 2,
			mode: "transcribe",
			inputKind: "images",
			source: "x",
			stem: "doc",
			fingerprint: { source: "x" },
			schema: { name: schema.name, sha256: schema.sha256, path: schema.path },
			units: [
				{
					id: "p0001",
					index: 1,
					status: "committed",
					contentHash: sha256Text(page("First page")),
					issues: [warning, { ...warning, pointer: undefined, message: "short page" }],
				},
				{ id: "p0002", index: 2, status: "committed", contentHash: sha256Text(page("Second page")) },
				{ id: "p0003", index: 3, status: "committed", contentHash: sha256Text(page("Third page")) },
			],
			sessions: [],
			createdAt: "",
			updatedAt: "",
		} as unknown as DocState;
		const out = writeOutputs(paths, state, schema);
		const json = JSON.parse(readFileSync(out.json, "utf8"));
		expect(json.pages[0].issues).toEqual([
			{ severity: "warning", layer: "quality", location: "/transcription", message: "repeated line" },
			{ severity: "warning", layer: "quality", message: "short page" },
		]);
		expect(json.mabillon).toMatchObject({ warnings: 2, units_with_warnings: 1, complete: false });
		expect(json.pages[1].integrity_error).toMatch(/changed after/);
		expect(json.pages[1].transcription).toBeUndefined();
		expect(json.pages[2].integrity_error).toMatch(/missing/);
		expect(json.mabillon.integrity_errors).toHaveLength(2);
		expect(readFileSync(out.markdown as string, "utf8")).not.toContain("Changed afterwards");
	});
});

describe("runs", () => {
	it("retries a transient provider error without closing the unit", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 2);
		let failures = 0;
		const responder = (context: TranscriptContext) => {
			if (failures < 2 && currentUnit(context) === "p0002") {
				failures++;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" });
			}
			return diligent(context);
		};
		const h = await harness(responder, { out: join(root, "out") });
		const summary = await h.run("transcribe", [folder]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc.committed).toBe(2);
		expect(doc.needsReview).toBe(0);
		expect(h.logs.some((line) => /retrying in/.test(line))).toBe(true);
	}, 60_000);

	it("stops the whole run on rejected credentials", async () => {
		const root = tempDir();
		const first = await makeImageFolder(join(root, "first"), 1);
		const second = await makeImageFolder(join(root, "second"), 1);
		const responder = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" });
		const h = await harness(responder, { out: join(root, "out") });
		const summary = await h.run("transcribe", [first, second]);
		expect(summary.fatalError).toMatch(/credentials/);
		expect(summary.documents).toHaveLength(1);
		expect(summary.documents[0].fatal).toBe(true);
		// The document the fatal error kept from starting is reported, not dropped.
		expect(summary.skipped).toEqual([{ path: second, reason: expect.stringMatching(/^not started: .*credentials/) }]);
		const state = JSON.parse(readFileSync(join(root, "out", "first", "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].status).toBe("pending");
	}, 60_000);

	it("refuses to resume when the source changed", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept.\n\nZweites Rezept.\n");
		const h = await harness(diligent, { out: join(root, "out"), schema: RECIPES_SCHEMA });
		const firstRun = await h.run("extract", [text]);
		expect(firstRun.documents[0].error).toBeUndefined();
		writeFileSync(text, "Ganz anderer Text.\n");
		const secondRun = await h.run("extract", [text]);
		expect(secondRun.documents[0].error).toMatch(/source differs/);
	}, 60_000);

	it("fails a corrupt PDF without stopping the batch", async () => {
		const root = tempDir();
		writeFileSync(join(root, "broken.pdf"), "%PDF-1.4\nnot really a pdf");
		const good = makePdf(join(root, "good.pdf"), ["Only page"]);
		const h = await harness(diligent, { out: join(root, "out"), dpi: 72 });
		const summary = await h.run("transcribe", [join(root, "broken.pdf"), good]);
		const broken = summary.documents.find((doc) => doc.stem === "broken");
		const fine = summary.documents.find((doc) => doc.stem === "good");
		expect(broken?.error).toBeDefined();
		expect(broken?.fatal).toBeUndefined();
		expect(fine?.committed).toBe(1);
	}, 60_000);

	it("removes page images of committed units from later requests", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 2);
		const h = await harness(diligent, { out: join(root, "out"), compactAtTokens: 10_000_000 });
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0].committed).toBe(2);
		const second = h.faux.requests.find((request) => currentUnit(request) === "p0002");
		expect(second).toBeDefined();
		const texts = second!.messages.map((message) => messageText(message)).join("\n");
		expect(texts).toContain("[image of an earlier unit omitted");
		// Only the current page remains as an image.
		const images = second!.messages.flatMap((message) =>
			message.role === "user" && Array.isArray(message.content)
				? message.content.filter((block) => block.type === "image")
				: [],
		);
		expect(images).toHaveLength(1);
	}, 60_000);

	it("counts tool calls with invalid arguments against the unit budget", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 1);
		const responder = () => call("verify", { final: "definitely" });
		const h = await harness(responder, { out: join(root, "out"), toolSoftCap: 2, toolHardCap: 3 });
		const summary = await h.run("transcribe", [folder]);
		const doc = summary.documents[0];
		expect(doc.error).toBeUndefined();
		expect(doc.needsReview).toBe(1);
		const state = JSON.parse(readFileSync(join(root, "out", "pages", "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].closedReason).toMatch(/tool budget/);
		// The censored unit is identifiable in the state and the outputs.
		expect(state.units[0].hardCapClosed).toBe(true);
		const output = JSON.parse(readFileSync(join(root, "out", "pages", "pages.json"), "utf8"));
		expect(output.mabillon.units_closed_by_hard_cap).toBe(1);
		expect(output.pages[0].hard_cap_closed).toBe(true);
	}, 60_000);

	it("records soft-cap blocks", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept. Take butter.\n");
		const steps = [
			() => call("read", { path: "notes.md" }),
			() => call("read", { path: "source/c0001.txt" }),
			() => call("read", { path: "source/c0001.txt", offset: 1 }),
			() =>
				call("write", {
					path: "units/c0001.json",
					content: JSON.stringify({ contains_no_content_of_requested_type: true, entries: [] }),
				}),
			() => call("verify", { final: true }),
		];
		let step = 0;
		const h = await harness(() => (steps[step++] ?? (() => say("done")))(), {
			out: join(root, "out"),
			schema: RECIPES_SCHEMA,
			toolSoftCap: 1,
			toolHardCap: 10,
		});
		const summary = await h.run("extract", [text]);
		expect(summary.documents[0].committed).toBe(1);
		const provenance = JSON.parse(readFileSync(join(root, "out", "notes", "notes.provenance.json"), "utf8"));
		expect(provenance.units[0].soft_cap_blocks).toBeGreaterThan(0);
		expect(provenance.mabillon.units_with_soft_cap_blocks).toBe(1);
		expect(provenance.units[0].session).toBe(1);
	}, 60_000);
});

describe("experiment records", () => {
	const recipes = () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept. Take butter.\nZweites Rezept.\n");
		return { root, text };
	};
	const emptyUnit = (context: TranscriptContext) => {
		const last = context.messages[context.messages.length - 1];
		if (last.role === "user" && currentUnit(context)) {
			return call("write", {
				path: `units/${currentUnit(context)}.json`,
				content: JSON.stringify({ contains_no_content_of_requested_type: true, entries: [] }),
			});
		}
		if (last.role === "toolResult" && last.toolName !== "verify") return call("verify", { final: true });
		return say("done");
	};
	const schema = RECIPES_SCHEMA;

	it("requires view, read and verify and a tool that creates the unit file", () => {
		expect(() => checkToolSet(["write", "verify"], { mode: "extract", inputKind: "text" })).toThrow(
			/read cannot be left out/,
		);
		expect(() => checkToolSet(["write", "verify"], { mode: "transcribe", inputKind: "images" })).toThrow(
			/view \(or python\) cannot be left out/,
		);
		expect(() => checkToolSet(["view", "edit", "verify"], { mode: "transcribe", inputKind: "images" })).toThrow(
			/no tool can create the unit file/,
		);
		expect(() =>
			checkToolSet(["read", "edit", "update_entry", "verify"], { mode: "extract", inputKind: "text" }),
		).toThrow(/write or add_entries/);
		// bash is an add-on (the soft cap takes it away), never the only writer.
		expect(() => checkToolSet(["read", "bash", "verify"], { mode: "extract", inputKind: "text" })).toThrow(
			/bash cannot be the only one/,
		);
		expect(() => checkToolSet(["view", "bash", "verify"], { mode: "transcribe", inputKind: "images" })).toThrow(
			/bash cannot be the only one/,
		);
		expect(() =>
			checkToolSet(["read", "add_entries", "verify"], { mode: "extract", inputKind: "text" }),
		).not.toThrow();
	});

	it("refuses a resume with a different tool set, context or settings, and records the experiment", async () => {
		const { root, text } = recipes();
		const out = join(root, "out");
		const first = await (await harness(emptyUnit, { out, schema, units: "1" })).run("extract", [text]);
		expect(first.documents[0].error).toBeUndefined();
		const tools = await (await harness(emptyUnit, { out, schema, tools: ["read", "write", "verify"] })).run(
			"extract",
			[text],
		);
		expect(tools.documents[0].error).toMatch(/cannot be resumed: it used the tools read, write, edit, verify/);
		const caps = await (await harness(emptyUnit, { out, schema, toolHardCap: 99 })).run("extract", [text]);
		expect(caps.documents[0].error).toMatch(/cannot be resumed: toolHardCap was 40 \(now 99\)/);
		writeFileSync(join(root, "context.md"), "Recipes from Basel.");
		const context = await (await harness(emptyUnit, { out, schema, autoContext: true })).run("extract", [text]);
		expect(context.documents[0].error).toMatch(/cannot be resumed: the context files differ/);
		rmSync(join(root, "context.md"));
		const resumed = await (await harness(emptyUnit, { out, schema })).run("extract", [text]);
		expect(resumed.documents[0].error).toBeUndefined();
		const provenance = JSON.parse(readFileSync(join(out, "notes", "notes.provenance.json"), "utf8"));
		const meta = provenance.mabillon;
		expect(meta.implementation.version).toMatch(/^\d+\.\d+\.\d+/);
		expect(meta.experiment.tools).toEqual(["read", "write", "edit", "verify", "add_entries", "update_entry"]);
		expect(meta.experiment.settings).toMatchObject({ toolSoftCap: 30, toolHardCap: 40, chunkTokens: 2500 });
		expect(meta.experiment.systemPromptSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(meta.session_settings[0]).toMatchObject({ session: 1, tools: meta.experiment.tools });
		expect(meta.session_settings[0].image_profile).toBeDefined();
		expect(provenance.units[0].session).toBe(1);
	}, 60_000);

	it("records the selected unit IDs", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 3);
		await (await harness(diligent, { out: join(root, "out"), units: "1,3" })).run("transcribe", [folder]);
		const output = JSON.parse(readFileSync(join(root, "out", "pages", "pages.json"), "utf8"));
		expect(output.mabillon.selection).toMatchObject({ units: 2, unit_ids: ["p0001", "p0003"] });
	}, 60_000);

	it("fails a document instead of lowering image fidelity with --no-image-fallback", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 1);
		const responder = () =>
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "400 Invalid value: 'original'. Supported values for detail are 'low', 'high' and 'auto'.",
			});
		const h = await harness(responder, { out: join(root, "out"), imageFallback: false });
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0].error).toMatch(/image fallback is off/);
	}, 60_000);

	it("refuses line ranges that leave lines out unless partial ranges are allowed", async () => {
		const { root, text } = recipes();
		writeFileSync(join(root, "notes_line_ranges.txt"), "(1, 1)\n");
		const refused = await (await harness(emptyUnit, { out: join(root, "out"), schema })).run("extract", [text]);
		expect(refused.documents[0].error).toMatch(/leaves source lines out \(lines 2-2 are in no range\)/);
		const allowed = await (
			await harness(emptyUnit, { out: join(root, "out2"), schema, allowPartialRanges: true })
		).run("extract", [text]);
		expect(allowed.documents[0].error).toBeUndefined();
		const provenance = JSON.parse(readFileSync(join(root, "out2", "notes", "notes.provenance.json"), "utf8"));
		expect(provenance.mabillon.uncovered_lines).toEqual(["lines 2-2 are in no range"]);
	}, 60_000);

	it("reports an export that is missing or stale as not complete", async () => {
		const { root, text } = recipes();
		const out = join(root, "out");
		await (await harness(emptyUnit, { out, schema })).run("extract", [text]);
		expect(collectStatus(join(out, "notes"))[0].complete).toBe(true);
		rmSync(join(out, "notes", "notes.json"));
		expect(collectStatus(join(out, "notes"))[0]).toMatchObject({
			complete: false,
			incompleteReason: "export missing or stale",
		});
	}, 60_000);

	it("leaves state and outputs untouched when a --redo-review resume is refused", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 2);
		const out = join(root, "out");
		await (await harness(() => say("Done."), { out, settleRetries: 0 })).run("transcribe", [folder]);
		const files = ["run/state.json", "pages.json", "pages.md"].map((file) => join(out, "pages", file));
		const before = files.map((file) => readFileSync(file));
		const refused = await (await harness(diligent, { out, redoReview: true, settleRetries: 2 })).run("transcribe", [
			folder,
		]);
		expect(refused.documents[0].error).toMatch(/cannot be resumed: settleRetries was 0 \(now 2\)/);
		files.forEach((file, i) => {
			expect(readFileSync(file).equals(before[i])).toBe(true);
		});
	}, 60_000);

	it("fails the run before any state change when bash is requested but no shell exists", async () => {
		const { root, text } = recipes();
		const faux = await createFauxRuntime(emptyUnit);
		cleanups.push(faux.cleanup);
		const run_ = () =>
			run({
				mode: "extract",
				inputs: [text],
				config: mergeConfig({
					model: "faux/faux-1",
					autoContext: false,
					out: join(root, "out"),
					schema,
					bash: true,
				}),
				log: () => undefined,
				services: {
					modelRuntime: faux.modelRuntime,
					agentDir: faux.agentDir,
					settings: { retry: { enabled: false } },
					findShell: () => ({ available: false }),
				},
			});
		await expect(run_()).rejects.toThrow(/no bash shell was found.*shellPath/);
		expect(existsSync(join(root, "out"))).toBe(false);
	}, 60_000);

	it("refuses to resume a run from before experiment records once the agent worked on it", async () => {
		const { root, text } = recipes();
		const out = join(root, "out");
		await (await harness(emptyUnit, { out, schema })).run("extract", [text]);
		const statePath = join(out, "notes", "run", "state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as DocState;
		const legacy = { ...state, experiment: undefined };
		writeFileSync(statePath, JSON.stringify(legacy));
		const refused = await (await harness(emptyUnit, { out, schema })).run("extract", [text]);
		expect(refused.documents[0].error).toMatch(/predates experiment records/);
		// An interrupted legacy run (no finished units, but a session and a draft) is refused as well.
		const interrupted = {
			...legacy,
			units: legacy.units.map((unit) => ({ ...unit, status: "pending", contentHash: undefined })),
		};
		writeFileSync(statePath, JSON.stringify(interrupted));
		const draft = await (await harness(emptyUnit, { out, schema })).run("extract", [text]);
		expect(draft.documents[0].error).toMatch(/predates experiment records/);
		// Only a legacy run the agent never worked on (no sessions, drafts or notes) adopts the current experiment.
		writeFileSync(statePath, JSON.stringify({ ...interrupted, sessions: [] }));
		rmSync(join(out, "notes", "work", "units"), { recursive: true, force: true });
		writeFileSync(join(out, "notes", "work", "notes.md"), "");
		const adopted = await (await harness(emptyUnit, { out, schema })).run("extract", [text]);
		expect(adopted.documents[0].error).toBeUndefined();
		expect((JSON.parse(readFileSync(statePath, "utf8")) as DocState).experiment).toBeDefined();
	}, 60_000);

	it("does not pass on suggestions of disabled tools from pi's read, nor in encoding refusals", async () => {
		const { root, text } = recipes();
		const replies: string[] = [];
		const long = `${"x".repeat(60 * 1024)}\n`;
		const steps = [
			() => call("write", { path: "scratch/long.txt", content: long }),
			() => call("read", { path: "scratch/long.txt" }),
		];
		await (
			await harness(
				(context) => {
					const last = context.messages[context.messages.length - 1];
					if (last.role === "toolResult") replies.push(messageText(last));
					return (steps[replies.length] ?? (() => say("done")))();
				},
				{ out: join(root, "out"), schema, settleRetries: 0 },
			)
		).run("extract", [text]);
		expect(replies[1]).toMatch(/cannot be displayed; continue with offset=2/);
		expect(replies[1]).not.toMatch(/\bbash\b|\bsed\b/);
		const arm = await (
			await harness(
				(context) => {
					const last = context.messages[context.messages.length - 1];
					if (last.role === "toolResult") replies.push(messageText(last));
					if (last.role === "user" && currentUnit(context)) {
						writeFileSync(
							join(root, "out2", "notes", "work", "units", "c0001.json"),
							Buffer.from('{"entries": [{"x": "Brühe"}]}', "latin1"),
						);
						return call("add_entries", { remove: [1] });
					}
					return say("done");
				},
				{ out: join(root, "out2"), schema, settleRetries: 0, tools: ["read", "verify", "add_entries"] },
			)
		).run("extract", [text]);
		expect(arm.documents[0].tools).toEqual(["read", "verify", "add_entries"]);
		const refusal = replies[replies.length - 1];
		expect(refusal).toMatch(/not valid UTF-8/);
		expect(refusal).not.toMatch(/\b(write|edit|bash)\b/);
	}, 60_000);

	it("refuses unsafe update_entry paths and a missing value", () => {
		const setup = addEntriesSetup(resolveSchema(schema, "extract", []));
		if (!setup) throw new Error("no setup");
		const file = JSON.stringify({
			contains_no_content_of_requested_type: false,
			entries: [{ title_original: null }],
		});
		for (const path of ["/__proto__/polluted", "/constructor/prototype/x", "/prototype"]) {
			expect(updateEntry(setup, file, 1, [{ path, value: 1 }]).errors?.[0]).toMatch(/cannot be set/);
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(updateEntry(setup, file, 1, [{ path: "/title_original" } as never]).errors?.[0]).toMatch(
			/a value is required/,
		);
		// Inherited properties never satisfy `required`.
		const inherited = Object.create({ text_original: "x" }) as Record<string, unknown>;
		expect(setup.entryErrors(inherited).join(" ")).toMatch(/missing required property "text_original"/);
	});
});

describe("run edge cases", () => {
	it("keeps the agent's file tools inside the work directory whatever the path syntax", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, Array.from({ length: 40 }, (_, i) => `Recipe ${i + 1}. Take butter and flour.`).join("\n\n"));
		writeFileSync(join(root, "secret.txt"), "top secret");
		const attempts = [
			"@../run/state.json",
			"~/.pi/agent/auth.json",
			`file://${join(root, "secret.txt")}`,
			"@source/c0009.txt",
		];
		const results: string[] = [];
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult" && last.toolName === "read") results.push(messageText(last));
			if (
				results.length < attempts.length &&
				(last.role === "user" || (last.role === "toolResult" && last.toolName === "read"))
			) {
				return call("read", { path: attempts[results.length] });
			}
			return diligent(context);
		};
		const h = await harness(responder, {
			out: join(root, "out"),
			schema: RECIPES_SCHEMA,
			chunkTokens: 60,
			units: "1",
		});
		const summary = await h.run("extract", [text]);
		expect(summary.documents[0].committed).toBe(1);
		expect(results).toHaveLength(4);
		for (const result of results.slice(0, 3)) expect(result).toMatch(/Only files inside the work directory/);
		expect(results[3]).toMatch(/c0009 is not available/);
		expect(results.join("\n")).not.toContain("top secret");
	}, 60_000);

	it("blocks look-ahead reads that differ only in case or trailing dots", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(
			text,
			Array.from({ length: 200 }, (_, i) => `Recipe ${i + 1}. Take butter and flour.`).join("\n\n"),
		);
		const options = { out: join(root, "out"), schema: RECIPES_SCHEMA, chunkTokens: 60 };
		// Unit 8 leaves c0007-c0010 in work/source; a later session on unit 1 must not read c0009.
		await (await harness(diligent, { ...options, units: "8" })).run("extract", [text]);
		const c0009 = readFileSync(join(root, "out", "notes", "work", "source", "c0009.txt"), "utf8");
		const attempts = ["Source/c0009.txt", "source./c0009.txt"];
		const results: string[] = [];
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult" && last.toolName === "read") results.push(messageText(last));
			if (
				results.length < attempts.length &&
				(last.role === "user" || (last.role === "toolResult" && last.toolName === "read"))
			) {
				return call("read", { path: attempts[results.length] });
			}
			return diligent(context);
		};
		const summary = await (await harness(responder, { ...options, units: "1" })).run("extract", [text]);
		expect(summary.documents[0].committed).toBe(1);
		expect(results).toHaveLength(2);
		expect(results.join("\n")).not.toContain(c0009.trim());
		if (process.platform === "win32") for (const result of results) expect(result).toMatch(/is not available/);
	}, 60_000);

	it("checks the file pi's read fallback would open, not only the requested path", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept. Take butter.\n");
		// pi retries a missing path with curly apostrophes throughout, which here leads to another folder.
		const decoy = join(root, "O’Brien", "notes", "work");
		mkdirSync(decoy, { recursive: true });
		writeFileSync(join(decoy, "secret.txt"), "top secret");
		const results: string[] = [];
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult" && last.toolName === "read") results.push(messageText(last));
			if (last.role === "user" && results.length === 0) return call("read", { path: "secret.txt" });
			return diligent(context);
		};
		const h = await harness(responder, {
			out: join(root, "O'Brien"),
			schema: RECIPES_SCHEMA,
		});
		const summary = await h.run("extract", [text]);
		expect(summary.documents[0].committed).toBe(1);
		expect(results[0]).toMatch(/Only files inside the work directory/);
		expect(results.join("\n")).not.toContain("top secret");
	}, 60_000);

	it("reopens finished units whose committed copy is missing or changed", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 3);
		const out = join(root, "out");
		const first = await (await harness(diligent, { out })).run("transcribe", [folder]);
		expect(first.documents[0].committed).toBe(3);
		const committed = join(out, "pages", "run", "committed");
		writeFileSync(join(committed, "p0002.md"), `${PAGE}Tampered text`);
		rmSync(join(committed, "p0003.md"));
		// Only unit 1 is selected: the reopened units stay pending and the export is not complete.
		const second = await (await harness(diligent, { out, units: "1" })).run("transcribe", [folder]);
		const warnings = second.documents[0].warnings ?? [];
		expect(warnings.some((warning) => /p0002: .*changed.*reopened/.test(warning))).toBe(true);
		expect(warnings.some((warning) => /p0003: .*missing.*reopened/.test(warning))).toBe(true);
		const output = JSON.parse(readFileSync(join(out, "pages", "pages.json"), "utf8"));
		expect(output.mabillon).toMatchObject({ complete: false, units_pending: 2 });
		expect(output.pages[1].status).toBe("pending");
		expect(JSON.stringify(output)).not.toContain("Tampered text");
		// A full rerun redoes them.
		const third = await (await harness(diligent, { out })).run("transcribe", [folder]);
		expect(third.documents[0]).toMatchObject({ committed: 3, pending: 0 });
		expect(readFileSync(join(out, "pages", "pages.md"), "utf8")).toContain("Text of p0002");
	}, 60_000);

	it("refuses to resume when the stored chunk text changed", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, Array.from({ length: 20 }, (_, i) => `Recipe ${i + 1}. Take butter and flour.`).join("\n\n"));
		const options = { out: join(root, "out"), schema: RECIPES_SCHEMA, chunkTokens: 60 };
		const first = await (await harness(diligent, { ...options, units: "1" })).run("extract", [text]);
		expect(first.documents[0].error).toBeUndefined();
		const chunk = join(root, "out", "notes", "run", "text", "c0002.txt");
		writeFileSync(chunk, readFileSync(chunk, "utf8").replace("butter", "lard"));
		const second = await (await harness(diligent, options)).run("extract", [text]);
		expect(second.documents[0].error).toMatch(/cannot be resumed: the stored text of c0002/);
	}, 60_000);

	it("resumes a run that recorded the legacy schema digest and upgrades it", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 2);
		const out = join(root, "out");
		await (await harness(diligent, { out, units: "1" })).run("transcribe", [folder]);
		const schema = resolveSchema(undefined, "transcribe", []);
		const statePath = join(out, "pages", "run", "state.json");
		const state = JSON.parse(readFileSync(statePath, "utf8")) as DocState;
		state.schema.sha256 = sha256Text(readFileSync(schema.path, "utf8"));
		expect(state.schema.sha256).not.toBe(schema.sha256);
		writeFileSync(statePath, JSON.stringify(state));
		const summary = await (await harness(diligent, { out })).run("transcribe", [folder]);
		expect(summary.documents[0].error).toBeUndefined();
		expect(summary.documents[0].committed).toBe(2);
		expect((JSON.parse(readFileSync(statePath, "utf8")) as DocState).schema.sha256).toBe(schema.sha256);
	}, 60_000);

	it("restores altered chunks in work/source from run/text at session start", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, Array.from({ length: 20 }, (_, i) => `Recipe ${i + 1}. Take butter and flour.`).join("\n\n"));
		const options = { out: join(root, "out"), schema: RECIPES_SCHEMA, chunkTokens: 60 };
		await (await harness(diligent, { ...options, units: "1" })).run("extract", [text]);
		const working = join(root, "out", "notes", "work", "source", "c0002.txt");
		const canonical = readFileSync(join(root, "out", "notes", "run", "text", "c0002.txt"), "utf8");
		writeFileSync(working, "Recipe 99. Take nothing at all.");
		const h = await harness(diligent, { ...options, units: "2" });
		const summary = await h.run("extract", [text]);
		expect(summary.documents[0].error).toBeUndefined();
		expect(readFileSync(working, "utf8")).toBe(canonical);
		expect(h.logs.some((line) => /source\/c0002\.txt differed/.test(line))).toBe(true);
		const prompts = h.faux.requests.map((request) => request.messages.map(messageText).join("\n")).join("\n");
		expect(prompts).not.toContain("Take nothing at all");
	}, 60_000);

	it("asks for confirmation before committing an extraction unit emptied after a draft with entries", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept. Take butter.\n");
		const replies: string[] = [];
		const responder = (context: TranscriptContext) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult") replies.push(messageText(last));
			const steps = [
				() =>
					call("write", {
						path: "units/c0001.json",
						content: JSON.stringify({
							contains_no_content_of_requested_type: false,
							entries: [{ a: 1 }, { b: 2 }],
						}),
					}),
				() =>
					call("write", {
						path: "units/c0001.json",
						content: JSON.stringify({ contains_no_content_of_requested_type: true, entries: [] }),
					}),
				() => call("verify", { final: true }),
				() => call("verify", { final: true }),
			];
			return (steps[results.length] ?? (() => say("done")))();
		};
		const h = await harness(responder, { out: join(root, "out"), schema: RECIPES_SCHEMA });
		const summary = await h.run("extract", [text]);
		expect(summary.documents[0].committed).toBe(1);
		expect(replies[2]).toMatch(/NOT COMMITTED: .*earlier draft of c0001 in this session had 2/);
		const state = JSON.parse(readFileSync(join(root, "out", "notes", "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].issues?.some((issue) => /earlier draft in this session had 2/.test(issue.message))).toBe(
			true,
		);
	}, 60_000);

	it("accepts a confirming commit only from a turn after the refusal", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept. Take butter.\n");
		const replies: string[] = [];
		const finalVerify = () => fauxToolCall("verify", { final: true });
		const responder = (context: TranscriptContext) => {
			const turns = context.messages.filter((message) => message.role === "assistant").length;
			for (const message of context.messages.slice(-2)) {
				if (message.role === "toolResult" && message.toolName === "verify") replies.push(messageText(message));
			}
			const write = (entries: unknown[]) =>
				call("write", {
					path: "units/c0001.json",
					content: JSON.stringify({ contains_no_content_of_requested_type: entries.length === 0, entries }),
				});
			if (turns === 0) return write([{ a: 1 }]);
			if (turns === 1) return write([]);
			// Two final verifies in one assistant message: both run before the model sees the first refusal.
			if (turns === 2) return fauxAssistantMessage([finalVerify(), finalVerify()], { stopReason: "toolUse" });
			if (turns === 3) return call("verify", { final: true });
			return say("done");
		};
		const h = await harness(responder, { out: join(root, "out"), schema: RECIPES_SCHEMA });
		const summary = await h.run("extract", [text]);
		expect(replies.slice(0, 2).every((reply) => /NOT COMMITTED: .*earlier draft/.test(reply))).toBe(true);
		expect(summary.documents[0].committed).toBe(1);
		const state = JSON.parse(readFileSync(join(root, "out", "notes", "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].verifyRuns).toBe(3);
	}, 60_000);

	it("blocks unit files that are not UTF-8 and accepts a byte order mark", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Brühe mit Käse.\n");
		const unitPath = join(root, "out", "notes", "work", "units", "c0001.json");
		const replies: string[] = [];
		const responder = (context: TranscriptContext) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult") replies.push(messageText(last));
			if (results.length === 0) {
				// A script on Windows writing cp1252 (as Python does without encoding="utf-8").
				writeFileSync(unitPath, Buffer.from('{"note": "Brühe"}', "latin1"));
				return call("verify", { final: true });
			}
			if (results.length === 1) {
				const json = JSON.stringify({ contains_no_content_of_requested_type: true, entries: [] });
				writeFileSync(unitPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json, "utf8")]));
				return call("verify", { final: true });
			}
			return say("done");
		};
		const h = await harness(responder, { out: join(root, "out"), schema: RECIPES_SCHEMA });
		const summary = await h.run("extract", [text]);
		expect(replies[0]).toMatch(/NOT COMMITTED/);
		expect(replies[0]).toMatch(/units\/c0001\.json is not valid UTF-8 .*rewrite it with write/);
		expect(summary.documents[0].committed).toBe(1);
		const committed = readFileSync(join(root, "out", "notes", "run", "committed", "c0001.json"), "utf8");
		expect(committed.startsWith("{")).toBe(true);
	}, 60_000);

	it("refuses the first commit of a unit whose entries cover too little of the chunk", async () => {
		const root = tempDir();
		const schemaDir = join(root, "schemas");
		mkdirSync(join(schemaDir, "rules"), { recursive: true });
		const entry = {
			type: "object",
			properties: { title_original: { type: ["string", "null"] }, text_original: { type: "string" } },
			required: ["title_original", "text_original"],
			additionalProperties: false,
		};
		writeFileSync(
			join(schemaDir, "mini.json"),
			JSON.stringify({
				name: "MiniRecipes",
				strict: true,
				schema: {
					type: "object",
					properties: {
						contains_no_content_of_requested_type: { type: "boolean" },
						entries: { type: "array", items: entry },
					},
					required: ["contains_no_content_of_requested_type", "entries"],
					additionalProperties: false,
				},
			}),
		);
		writeFileSync(
			join(schemaDir, "rules", "MiniRecipes.rules.json"),
			JSON.stringify({ verbatimFields: ["text_original"] }),
		);
		const recipes = [
			"To make a Tart of Hearbs. Take spinach, parsley and beets, boil them tender, chop them small and season with sugar.",
			"To make Fritters. Take flour, eggs and milk, beat them to a batter, put in apples sliced thin and fry them in butter.",
			"To make a Sallet of Cucumbers. Pare them and slice them thin, lay them in a dish with vinegar, oil, salt and pepper.",
			"To make Gooseberry Fool. Scald the gooseberries until they break, strain them, sweeten and mix with thick cream.",
		];
		const text = join(root, "cookbook.txt");
		writeFileSync(text, recipes.join("\n\n"));
		const replies: string[] = [];
		const responder = (context: TranscriptContext) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult") replies.push(messageText(last));
			const content = JSON.stringify({
				contains_no_content_of_requested_type: false,
				entries: [{ title_original: null, text_original: recipes[0] }],
			});
			const steps = [
				() => call("write", { path: "units/c0001.json", content }),
				() => call("verify", {}),
				() => call("verify", { final: true }),
				() => call("verify", { final: true }),
			];
			return (steps[results.length] ?? (() => say("done")))();
		};
		const h = await harness(responder, { out: join(root, "out"), schema: "MiniRecipes", schemasDirs: [schemaDir] });
		const summary = await h.run("extract", [text]);
		expect(summary.documents[0].committed).toBe(1);
		expect(replies[1]).toMatch(/Resolve or knowingly accept the warnings above.*irreversible/);
		expect(replies[2]).toMatch(/^Not committed: entries' verbatim text covers only \d+% of the chunk/);
		expect(replies[2]).toMatch(/keep the entries and call verify final=true again to confirm/);
		expect(replies[2]).not.toContain("contains_no_content_of_requested_type");
		const state = JSON.parse(readFileSync(join(root, "out", "cookbook", "run", "state.json"), "utf8")) as DocState;
		expect(
			state.units[0].issues?.some((issue) => issue.message.startsWith("entries' verbatim text covers only")),
		).toBe(true);
	}, 60_000);

	it("finds the pages of an image folder that was moved between runs", async () => {
		const root = tempDir();
		mkdirSync(join(root, "old"));
		mkdirSync(join(root, "new"));
		const folder = await makeImageFolder(join(root, "old", "pages"), 2);
		const out = join(root, "out");
		await (await harness(diligent, { out, units: "1" })).run("transcribe", [folder]);
		const moved = join(root, "new", "pages");
		renameSync(folder, moved);
		const summary = await (await harness(diligent, { out })).run("transcribe", [moved]);
		expect(summary.documents[0]).toMatchObject({ committed: 2, needsReview: 0 });
		const state = JSON.parse(readFileSync(join(out, "pages", "run", "state.json"), "utf8")) as DocState;
		expect(state.units.every((unit) => unit.image?.startsWith(moved))).toBe(true);
	}, 60_000);

	it("reports a merged extraction that fails the schema as failed", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept. Take butter.\n");
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "user" && currentUnit(context)) {
				const content = JSON.stringify({ contains_no_content_of_requested_type: false, entries: [{ bogus: 1 }] });
				return call("write", { path: "units/c0001.json", content });
			}
			return say("Done.");
		};
		const h = await harness(responder, {
			out: join(root, "out"),
			schema: RECIPES_SCHEMA,
			settleRetries: 0,
		});
		const summary = await h.run("extract", [text]);
		const doc = summary.documents[0];
		expect(doc.needsReview).toBe(1);
		expect(doc.finalValidation?.length).toBeGreaterThan(0);
		expect(runExitCode([doc], false, false)).toBe(1);
		const provenance = JSON.parse(readFileSync(join(root, "out", "notes", "notes.provenance.json"), "utf8"));
		expect(provenance.mabillon.final_validation).toEqual(doc.finalValidation);
		// Each unit record carries its remaining issues with severity, location and message.
		expect(provenance.units[0].issues.some((issue: { severity: string }) => issue.severity === "error")).toBe(true);
		// status reads the outcome of the export from the state.
		const [status] = collectStatus(join(root, "out", "notes"));
		expect(status.complete).toBe(false);
		expect(status.finalValidation).toEqual(doc.finalValidation);
	}, 60_000);

	it("asks for a second look before committing an empty extraction of a substantial chunk", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(
			text,
			Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of a preface about the author.`).join("\n"),
		);
		const replies: string[] = [];
		const empty = JSON.stringify({ contains_no_content_of_requested_type: true, entries: [] });
		const steps = [
			() => call("write", { path: "units/c0001.json", content: empty }),
			() => call("verify", { final: true }),
			() => call("verify", { final: true }),
		];
		const h = await harness(
			(context) => {
				const last = context.messages[context.messages.length - 1];
				if (last.role === "toolResult") replies.push(messageText(last));
				return (steps[replies.length] ?? (() => say("done")))();
			},
			{ out: join(root, "out"), schema: RECIPES_SCHEMA },
		);
		const summary = await h.run("extract", [text]);
		expect(replies[1]).toMatch(/NOT COMMITTED: units\/c0001\.json has no entries, but the chunk has content/);
		expect(summary.documents[0].committed).toBe(1);
		const state = JSON.parse(readFileSync(join(root, "out", "notes", "run", "state.json"), "utf8")) as DocState;
		expect(
			state.units[0].issues?.some((issue) => /confirmed by the agent after a second look/.test(issue.message)),
		).toBe(true);
	}, 60_000);

	it("ends the session as soon as three units in a row are closed for review", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 5);
		for (const i of [1, 2, 3, 4]) writeFileSync(join(folder, `scan_${i}.png`), "not an image");
		const h = await harness(diligent, { out: join(root, "out") });
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0].error).toMatch(/3 consecutive units were closed for review/);
		const state = JSON.parse(readFileSync(join(root, "out", "pages", "run", "state.json"), "utf8")) as DocState;
		expect(state.units.map((unit) => unit.status)).toEqual([
			"needs_review",
			"needs_review",
			"needs_review",
			"pending",
			"pending",
		]);
	}, 60_000);

	it("rejects extraction schemas without an entries array", async () => {
		const root = tempDir();
		const dir = join(root, "schemas");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "flat.json"),
			JSON.stringify({ name: "Flat", schema: { type: "object", properties: { title: { type: "string" } } } }),
		);
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept.\n");
		const h = await harness(diligent, { out: join(root, "out"), schema: "Flat", schemasDirs: [dir] });
		await expect(h.run("extract", [text])).rejects.toThrow(/no top-level "entries" array/);
	});

	it("does not replace a broken user schema with the bundled one of the same name", () => {
		const dir = join(tempDir(), "schemas");
		mkdirSync(dir);
		writeFileSync(join(dir, "recipes.json"), JSON.stringify({ name: "PriceListEntries", schema: { type: 5 } }));
		expect(() => resolveSchema("PriceListEntries", "extract", [dir])).toThrow(
			/could not be loaded: .*Invalid JSON Schema/,
		);
		expect(() => resolveSchema("recipes", "extract", [dir])).toThrow(/could not be loaded/);
	});

	it("parses and applies the tool set", () => {
		expect(coerceConfigValue("tools", "Read, write,verify", ".")).toEqual(["read", "write", "verify"]);
		expect(() => coerceConfigValue("tools", "read,shell,verify", ".")).toThrow(/unknown tool shell/);
		expect(() => coerceConfigValue("tools", "read,write", ".")).toThrow(/must include verify/);
		const where = { mode: "extract" as const, inputKind: "text" as const, entries: true };
		expect(effectiveTools({}, where)).toEqual(["read", "write", "edit", "verify", "add_entries", "update_entry"]);
		expect(effectiveTools({ bash: true }, where)).toContain("bash");
		expect(effectiveTools({ tools: ["read", "bash", "verify"], bash: false }, where)).toEqual(["read", "verify"]);
		expect(effectiveTools({}, { ...where, inputKind: "images" })).toContain("view");
		expect(effectiveTools({}, { mode: "transcribe", inputKind: "images", entries: false })).toEqual([
			"read",
			"write",
			"edit",
			"view",
			"verify",
		]);
	});

	it("mentions only the enabled tools in the prompt", () => {
		const schema = resolveSchema(RECIPES_SCHEMA, "extract", []);
		const prompt = (tools: ToolName[], inputKind: "images" | "text" = "text") =>
			buildSystemPrompt({
				mode: "extract",
				inputKind,
				schema,
				config: mergeConfig({}),
				tools: new Set(tools),
				context: { texts: [], images: [] },
				documentLabel: "x",
				totalUnits: 2,
			}).replace(/## Schema[\s\S]*$/, "");
		const full = prompt(["read", "write", "edit", "verify", "add_entries", "update_entry", "bash"]);
		for (const name of ["add_entries", "update_entry", "bash", "edit"]) expect(full).toContain(name);
		const plain = prompt(["read", "write", "edit", "verify"]);
		for (const name of ["add_entries", "update_entry", "bash", "remove=", "position="]) {
			expect(plain).not.toContain(name);
		}
		expect(plain).toMatch(/Write the unit file with all entries/);
		const noUpdate = prompt(["read", "write", "edit", "verify", "add_entries"]);
		expect(noUpdate).not.toContain("update_entry");
		expect(noUpdate).toMatch(/remove=\[n\] plus the corrected entry at position=n/);
	});

	it("never mentions a disabled tool in what the agent reads, for every ablation arm", async () => {
		const ablatable: ToolName[] = ["write", "edit", "bash", "add_entries", "update_entry"];
		const extraction = resolveSchema(RECIPES_SCHEMA, "extract", []);
		const transcription = resolveSchema(undefined, "transcribe", []);
		const arms: Array<{ mode: "extract" | "transcribe"; inputKind: "images" | "text"; tools: ToolName[] }> = [
			{ mode: "extract", inputKind: "text", tools: ["read", "verify", "add_entries"] },
			{ mode: "extract", inputKind: "text", tools: ["read", "verify", "write"] },
			{ mode: "extract", inputKind: "text", tools: ["read", "verify", "write", "edit"] },
			{ mode: "extract", inputKind: "text", tools: ["read", "verify", "add_entries", "update_entry"] },
			{ mode: "extract", inputKind: "text", tools: ["read", "verify", "add_entries", "bash"] },
			{ mode: "extract", inputKind: "images", tools: ["view", "verify", "add_entries"] },
			{ mode: "transcribe", inputKind: "images", tools: ["view", "verify", "write"] },
			{ mode: "transcribe", inputKind: "images", tools: ["view", "verify", "write", "bash"] },
		];
		for (const arm of arms) {
			checkToolSet(arm.tools, arm);
			const tools = new Set(arm.tools);
			const schema = arm.mode === "extract" ? extraction : transcription;
			const units = [1, 2].map((index) => ({
				id: `${arm.inputKind === "text" ? "c" : "p"}000${index}`,
				index,
				status: "pending" as const,
				startLine: 1,
				endLine: 2,
				rejections: { next: 2, pending: [{ id: "R1", text: "(entry 1, 'x': bad)", position: 1 }] },
			}));
			const runtime = {
				workDir: tempDir(),
				paths: docPaths(tempDir()),
				mode: arm.mode,
				inputKind: arm.inputKind,
				schema,
				config: mergeConfig({}),
				state: { units, stem: "x" },
				batch: [units[0]],
				tools,
				documentLabel: "x",
				contextImages: [],
				imageProfile: resolveImageProfile(undefined, "standard"),
				sources: { text: () => "Erstes Rezept.\nZweites Rezept.", materialize: () => undefined },
				persist: () => undefined,
				log: () => undefined,
			} as unknown as SessionRuntime;
			const file = `units/${units[0].id}.${arm.mode === "extract" ? "json" : "md"}`;
			const texts = [
				buildSystemPrompt({
					mode: arm.mode,
					inputKind: arm.inputKind,
					schema,
					config: mergeConfig({}),
					tools,
					context: { texts: [], images: [] },
					documentLabel: "x",
					totalUnits: 2,
				})
					// The schema's own texts ("Write footnote references as ...") are not about tools.
					.replace(/## (Transcription rules|Schema)[\s\S]*$/, ""),
				sessionIntro(runtime),
				stateSummary(runtime, units[0], true),
				...(arm.inputKind === "text"
					? (await unitContent(runtime, units[0])).map((block) => (block.type === "text" ? block.text : ""))
					: []),
				closingInstruction(tools, file, arm.mode),
				emptyDraftRefusal(tools, file, units[0].id, 3),
				emptyContentRefusal(file, arm.inputKind),
				coverageRefusal(tools, file, "entries' verbatim text covers only 20% of the chunk"),
				notInContext(arm.inputKind, units[0].id),
				softCapRefusal(tools, units[0].id, 30),
				notUtf8Error(tools, file),
				rejectionList(tools, units[0].id, units[0].rejections.pending) ?? "",
			].join("\n");
			for (const name of ablatable.filter((tool) => !tools.has(tool))) {
				expect(texts, `${arm.mode} ${arm.inputKind} [${arm.tools.join(",")}] mentions ${name}`).not.toMatch(
					new RegExp(`\\b${name}\\b`, "i"),
				);
			}
		}
	});

	it("keeps the boundary policy of the schema in the prompt", () => {
		const prompt = (schema: LoadedSchema) =>
			buildSystemPrompt({
				mode: "extract",
				inputKind: "images",
				schema,
				config: mergeConfig({}),
				tools: new Set(DEFAULT_TOOLS),
				context: { texts: [], images: [] },
				documentLabel: "x",
				totalUnits: 2,
			});
		const listings = resolveSchema(GUIDE_SCHEMA, "extract", []);
		expect(boundaryPolicy(listings)).toBe("fragments");
		expect(prompt(listings)).toMatch(/flagged as a fragment/);
		expect(prompt(listings)).toMatch(/do not pass `carry_over`/);
		expect(prompt(listings)).not.toMatch(/to complete it, record the complete entry/);
		const recipes = resolveSchema(RECIPES_SCHEMA, "extract", []);
		expect(boundaryPolicy(recipes)).toBe("complete");
		expect(prompt(recipes)).toMatch(/record the complete entry in the current unit/);
		// Without a rules file, a boolean fragment flag on the entries selects fragments.
		const dir = join(tempDir(), "schemas");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "guide.json"),
			JSON.stringify({
				name: "Guide",
				schema: {
					type: "object",
					properties: {
						entries: {
							type: "array",
							items: {
								type: "object",
								properties: { name: { type: "string" }, is_fragment: { type: "boolean" } },
							},
						},
					},
				},
			}),
		);
		expect(boundaryPolicy(loadSchemaFile(join(dir, "guide.json")))).toBe("fragments");
	});

	it("re-runs only selected review units with --redo-review", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 2);
		const lazy = await harness(() => say("Done."), { out: join(root, "out"), settleRetries: 0 });
		const first = await lazy.run("transcribe", [folder]);
		expect(first.documents[0].needsReview).toBe(2);
		// The same settings as the first run: a resume must run the same experiment arm.
		const redo = await harness(diligent, { out: join(root, "out"), redoReview: true, units: "1", settleRetries: 0 });
		const second = await redo.run("transcribe", [folder]);
		// Result counts are relative to the selection; the unit outside it keeps its review status and draft.
		expect(second.documents[0].committed).toBe(1);
		expect(second.documents[0].needsReview).toBe(0);
		const state = JSON.parse(readFileSync(join(root, "out", "pages", "run", "state.json"), "utf8")) as DocState;
		expect(state.units.map((unit) => unit.status)).toEqual(["committed", "needs_review"]);
	}, 60_000);

	it("does not fail a document whose sessions keep making progress between transient errors", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 4);
		const failedFor = new Set<string>();
		const responder = (context: TranscriptContext) => {
			const unit = currentUnit(context);
			const last = context.messages[context.messages.length - 1];
			// The first request after each unit's delivery fails once, from p0002 on.
			if (unit && unit !== "p0001" && !failedFor.has(unit) && last.role !== "toolResult") {
				failedFor.add(unit);
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 Service Unavailable" });
			}
			return diligent(context);
		};
		const h = await harness(responder, { out: join(root, "out") });
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0].error).toBeUndefined();
		expect(summary.documents[0].committed).toBe(4);
	}, 60_000);

	it("delivers the next unit once when a page cannot be prepared", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 2);
		writeFileSync(join(folder, "scan_1.png"), "not an image");
		const blocked: string[] = [];
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "toolResult" && /has not been delivered yet/.test(messageText(last)))
				blocked.push(messageText(last));
			return diligent(context);
		};
		const h = await harness(responder, { out: join(root, "out") });
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0].committed).toBe(1);
		expect(summary.documents[0].needsReview).toBe(1);
		expect(blocked).toHaveLength(0);
		const last = h.faux.requests[h.faux.requests.length - 1];
		const deliveries = last.messages.filter((message) => /Current unit: p0002/.test(messageText(message)));
		expect(deliveries).toHaveLength(1);
	}, 60_000);
});

/** A small recipe schema with a verbatim field and one other top-level field, in `dir`. */
function writeMiniSchema(dir: string): string {
	mkdirSync(join(dir, "rules"), { recursive: true });
	writeFileSync(
		join(dir, "mini.json"),
		JSON.stringify({
			name: "MiniRecipes",
			strict: true,
			schema: {
				type: "object",
				properties: {
					contains_no_content_of_requested_type: { type: "boolean" },
					section: { type: ["string", "null"], description: "Running head of the unit." },
					entries: { type: "array", items: { $ref: "#/$defs/entry" } },
				},
				required: ["contains_no_content_of_requested_type", "section", "entries"],
				additionalProperties: false,
				$defs: {
					entry: {
						type: "object",
						properties: {
							title_original: { type: ["string", "null"], description: "Title as printed." },
							text_original: { type: "string" },
						},
						required: ["title_original", "text_original"],
						additionalProperties: false,
					},
				},
			},
		}),
	);
	writeFileSync(join(dir, "rules", "MiniRecipes.rules.json"), JSON.stringify({ verbatimFields: ["text_original"] }));
	return dir;
}

const UMLAUT_RECIPES = [
	"Hühnerbrühe. Nimm ein Huhn und koche es.",
	"Käsesuppe. Reibe den Käse in die Brühe.",
	"Apfelküchlein. Schäle die Äpfel und backe sie.",
];

describe("add_entries", () => {
	async function extractRun(responder: (context: TranscriptContext) => AssistantMessage, overrides = {}) {
		const root = tempDir();
		const text = join(root, "kochbuch.txt");
		writeFileSync(text, UMLAUT_RECIPES.join("\n\n"));
		const h = await harness(responder, {
			out: join(root, "out"),
			schema: "MiniRecipes",
			schemasDirs: [writeMiniSchema(join(root, "schemas"))],
			...overrides,
		});
		const summary = await h.run("extract", [text]);
		const docDir = join(root, "out", "kochbuch");
		return { summary, docDir, h };
	}
	const entry = (i: number) => ({ title_original: null, text_original: UMLAUT_RECIPES[i] });
	/** Replies to the agent's tool calls (the last tool result of each request). */
	const collect = (replies: string[], context: TranscriptContext) => {
		const last = context.messages[context.messages.length - 1];
		if (last.role === "toolResult") replies.push(messageText(last));
	};

	it("declares the schema's entry structure, small enough for providers", () => {
		const setup = addEntriesSetup(resolveSchema(RECIPES_SCHEMA, "extract", []));
		expect(setup?.generic).toBe(false);
		const size = JSON.stringify(setup?.parameters).length;
		expect(size).toBeLessThan(MAX_TOOL_SCHEMA_CHARS);
		const items = (setup?.parameters.properties as Record<string, { items: Record<string, unknown> }>).entries.items;
		expect(JSON.stringify(items)).not.toContain("$ref");
		expect(JSON.stringify(items)).not.toContain('"description"');
		expect(items.required).toContain("text_original");
		expect(addEntriesSetup(resolveSchema(undefined, "transcribe", []))).toBeUndefined();
	});

	it("builds a unit from two calls, writes indented UTF-8 and commits it", async () => {
		const replies: string[] = [];
		const steps = [
			() => call("add_entries", { entries: [entry(0), entry(1)], fields: { section: "Suppen" } }),
			() => call("add_entries", { entries: [entry(2)] }),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		expect(summary.documents[0].committed).toBe(1);
		expect(replies[0]).toMatch(/units\/c0001\.json now has 2 entries \(added 2\)/);
		expect(replies[1]).toMatch(/now has 3 entries \(added 1\)/);
		const committed = readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8");
		expect(committed).toContain('\n  "entries": [\n');
		expect(committed).toContain("Hühnerbrühe");
		const data = JSON.parse(committed);
		expect(data).toMatchObject({ contains_no_content_of_requested_type: false, section: "Suppen" });
		expect(data.entries).toEqual([entry(0), entry(1), entry(2)]);
	}, 60_000);

	it("rejects invalid entries one by one and appends the valid ones", async () => {
		const replies: string[] = [];
		const steps = [
			() => call("add_entries", { entries: [entry(0), { title: "x" }, entry(1)], fields: { section: 5 } }),
			() => call("add_entries", { entries: [{ text_original: 3 }] }),
			() => call("add_entries", { entries: [entry(2)] }),
			// R1 and R2 are never resolved: the first final is refused, a later one commits with the warning.
			() => call("verify", { final: true }),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		expect(replies[0]).toMatch(/now has 2 entries \(added 2, rejected 1\)/);
		expect(replies[0]).toMatch(/R1: entry 2 \(position 2\): .*missing required property "text_original"/);
		expect(replies[0]).toMatch(/fields not set: \/section must be string,null/);
		expect(replies[0]).toMatch(
			/Entries:\n1\. Hühnerbrühe.*\n {3}\[R1 belongs here: resend it with position=2\]\n2\. Käsesuppe/,
		);
		expect(replies[1]).toMatch(/has 2 entries \(added 0, rejected 1\)/);
		expect(replies[1]).toMatch(/R2: entry 1 \(position 3\):/);
		expect(replies[1]).toMatch(/Pending rejections: R1\./);
		expect(replies[3]).toMatch(/^Not committed: add_entries rejections not resolved: R1 .*; R2 /);
		expect(summary.documents[0].committed).toBe(1);
		const state = JSON.parse(readFileSync(join(docDir, "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].issues?.some((issue) => issue.message.startsWith(PENDING_REJECTIONS_WARNING))).toBe(true);
		const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		expect(data.entries).toEqual([entry(0), entry(1), entry(2)]);
		expect(data.section).toBeNull();
	}, 60_000);

	it("removes entries by number and refuses numbers out of range", async () => {
		const replies: string[] = [];
		const wrong = { title_original: null, text_original: "Erfundenes Rezept ohne Quelle." };
		const steps = [
			() => call("add_entries", { entries: [entry(0), wrong, entry(1)] }),
			() => call("add_entries", { remove: [9] }),
			() => call("add_entries", { remove: [2], entries: [entry(2)] }),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		expect(replies[1]).toMatch(/has 3 entries; no entry 9 to remove\. Nothing was changed/);
		expect(replies[2]).toMatch(/now has 3 entries \(added 1, removed 1\)/);
		expect(replies[2]).toMatch(/Entries:\n1\. Hühnerbrühe.*\n2\. Käsesuppe.*\n3\. Apfelküchlein/);
		expect(summary.documents[0].committed).toBe(1);
		const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		expect(data.entries).toEqual([entry(0), entry(1), entry(2)]);
	}, 60_000);

	it("counts toward the budget like write and stays available after the soft cap", async () => {
		const replies: string[] = [];
		const steps = [
			() => call("add_entries", { entries: [entry(0)] }),
			() => call("add_entries", { entries: [entry(1)] }),
			() => call("add_entries", { entries: [entry(2)] }),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun(
			(context) => {
				collect(replies, context);
				return (steps[replies.length] ?? (() => say("done")))();
			},
			{ toolSoftCap: 2, toolHardCap: 5 },
		);
		expect(replies[2]).toMatch(/now has 3 entries/);
		expect(summary.documents[0].committed).toBe(1);
		const state = JSON.parse(readFileSync(join(docDir, "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].toolCalls).toBe(4);
	}, 60_000);

	it("updates single fields of an entry and leaves the file untouched when the result is invalid", async () => {
		const replies: string[] = [];
		const misspelled = { title_original: null, text_original: "Hünerbrühe. Nimm ein Huhn und koche es." };
		const steps = [
			() => call("add_entries", { entries: [misspelled, entry(1), entry(2)] }),
			// The second change is invalid, so the first must not be applied either.
			() =>
				call("update_entry", {
					number: 1,
					changes: [
						{ path: "/title_original", value: "Neu" },
						{ path: "/text_original", value: 5 },
					],
				}),
			() => call("update_entry", { number: 4, changes: [{ path: "/title_original", value: "x" }] }),
			() =>
				call("update_entry", {
					number: 1,
					changes: [{ path: "/text_original", value: UMLAUT_RECIPES[0] }],
				}),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		expect(replies[1]).toMatch(/^Entry 1 of units\/c0001\.json was not changed:\n- \/text_original must be string/);
		expect(replies[2]).toMatch(/there is no entry 4 \(the file has 3\)/);
		expect(replies[3]).toMatch(/entry 1 updated \(1 change\(s\)\)/);
		expect(replies[3]).toMatch(/Entries:\n1\. Hühnerbrühe/);
		expect(summary.documents[0].committed).toBe(1);
		const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		expect(data.entries).toEqual([entry(0), entry(1), entry(2)]);
	}, 60_000);

	it("updates nested paths and appends to arrays", () => {
		const dir = join(tempDir(), "schemas");
		mkdirSync(dir);
		writeFileSync(
			join(dir, "nested.json"),
			JSON.stringify({
				name: "Nested",
				schema: {
					type: "object",
					properties: {
						entries: {
							type: "array",
							items: {
								type: "object",
								properties: {
									name: { type: "string" },
									ingredients: {
										type: "array",
										items: {
											type: "object",
											properties: { q: { type: ["string", "null"] } },
											additionalProperties: false,
										},
									},
								},
								required: ["name"],
								additionalProperties: false,
							},
						},
					},
				},
			}),
		);
		const setup = addEntriesSetup(loadSchemaFile(join(dir, "nested.json")));
		if (!setup) throw new Error("no setup");
		const file = JSON.stringify({ entries: [{ name: "Tart", ingredients: [{ q: "1 lb" }] }] });
		const nested = updateEntry(setup, file, 1, [
			{ path: "/ingredients/0/q", value: null },
			{ path: "/ingredients/-", value: { q: "2 eggs" } },
		]);
		expect(nested.entry).toEqual({ name: "Tart", ingredients: [{ q: null }, { q: "2 eggs" }] });
		expect(updateEntry(setup, file, 1, [{ path: "/ingredients/5/q", value: "x" }]).errors?.[0]).toMatch(
			/index 5 does not exist|5 does not exist/,
		);
		expect(updateEntry(setup, file, 1, [{ path: "/colour", value: "red" }]).errors?.[0]).toMatch(
			/unexpected property "colour"/,
		);
		expect(updateEntry(setup, file, 2, [{ path: "/name", value: "x" }]).errors?.[0]).toMatch(/no entry 2/);
		expect(updateEntry(setup, file, 1, [{ path: "name", value: "x" }]).errors?.[0]).toMatch(/JSON pointer/);
	});

	it("records the tool set and leaves bash out by default", async () => {
		const replies: string[] = [];
		const steps = [
			() => call("add_entries", { entries: UMLAUT_RECIPES.map((_, i) => entry(i)) }),
			() => call("verify", { final: true }),
		];
		const { summary, docDir, h } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		const expected = ["read", "write", "edit", "verify", "add_entries", "update_entry"];
		expect(summary.documents[0].tools).toEqual(expected);
		const provenance = JSON.parse(readFileSync(join(docDir, "kochbuch.provenance.json"), "utf8"));
		expect(provenance.mabillon.tools).toEqual(expected);
		const request = JSON.stringify(h.faux.requests[0]);
		expect(request).toContain("## Tools");
		expect(request).not.toContain("- bash:");
	}, 60_000);

	it("runs with a reduced tool set for ablations", async () => {
		const replies: string[] = [];
		const steps = [
			() => call("add_entries", { entries: [entry(0)] }),
			() =>
				call("write", {
					path: "units/c0001.json",
					content: JSON.stringify({
						contains_no_content_of_requested_type: false,
						section: null,
						entries: UMLAUT_RECIPES.map((_, i) => entry(i)),
					}),
				}),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun(
			(context) => {
				collect(replies, context);
				return (steps[replies.length] ?? (() => say("done")))();
			},
			{ tools: ["read", "write", "verify"] },
		);
		expect(replies[0]).toMatch(/not found|unknown|not available/i);
		expect(summary.documents[0].committed).toBe(1);
		expect(summary.documents[0].tools).toEqual(["read", "write", "verify"]);
		const state = JSON.parse(readFileSync(join(docDir, "run", "state.json"), "utf8")) as DocState;
		expect(state.sessions[0].tools).toEqual(["read", "write", "verify"]);
	}, 60_000);

	it("cannot change a unit after its commit", async () => {
		const replies: string[] = [];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			if (replies.length === 0) return call("add_entries", { entries: [entry(0)] });
			if (replies.length === 1) {
				return fauxAssistantMessage(
					[
						fauxToolCall("verify", { final: true }),
						fauxToolCall("add_entries", { entries: [entry(1)] }),
						fauxToolCall("update_entry", { number: 1, changes: [{ path: "/title_original", value: "x" }] }),
					],
					{ stopReason: "toolUse" },
				);
			}
			return say("done");
		});
		expect(summary.documents[0].committed).toBe(1);
		const committed = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		const working = JSON.parse(readFileSync(join(docDir, "work", "units", "c0001.json"), "utf8"));
		expect(committed.entries).toHaveLength(1);
		expect(working.entries).toHaveLength(1);
		expect(working.entries[0].title_original).toBeNull();
	}, 60_000);

	it("refuses to replace an entries value that is not an array", async () => {
		const replies: string[] = [];
		const broken = JSON.stringify({ contains_no_content_of_requested_type: false, section: null, entries: "oops" });
		const steps = [
			() => call("write", { path: "units/c0001.json", content: broken }),
			() => call("add_entries", { entries: [entry(0)] }),
		];
		const { docDir } = await extractRun(
			(context) => {
				collect(replies, context);
				return (steps[replies.length] ?? (() => say("done")))();
			},
			{ settleRetries: 0 },
		);
		expect(replies[1]).toMatch(/units\/c0001\.json has an `entries` value that is not an array; fix it with edit/);
		expect(readFileSync(join(docDir, "work", "units", "c0001.json"), "utf8")).toBe(broken);
	}, 60_000);

	it("validates against #/properties refs and accepts a top-level field named title", async () => {
		const root = tempDir();
		const dir = join(root, "schemas");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "refs.json"),
			JSON.stringify({
				name: "RefRecipes",
				schema: {
					type: "object",
					properties: {
						contains_no_content_of_requested_type: { type: "boolean" },
						title: { type: ["string", "null"], description: "Title of the section." },
						template: {
							type: "object",
							properties: { text_original: { type: "string" } },
							required: ["text_original"],
							additionalProperties: false,
						},
						entries: { type: "array", items: { $ref: "#/properties/template" } },
					},
					required: ["contains_no_content_of_requested_type", "entries"],
					additionalProperties: false,
				},
			}),
		);
		const setup = addEntriesSetup(loadSchemaFile(join(dir, "refs.json")));
		expect(setup?.entryErrors({ text_original: "x" })).toEqual([]);
		expect(setup?.entryErrors({ recipe_text: "x" }).length).toBeGreaterThan(0);
		const fieldsDeclared = (setup?.parameters.properties as Record<string, { properties: Record<string, unknown> }>)
			.fields.properties;
		expect(Object.keys(fieldsDeclared)).toContain("title");

		const text = join(root, "kochbuch.txt");
		writeFileSync(text, UMLAUT_RECIPES.join("\n\n"));
		const replies: string[] = [];
		const steps = [
			() =>
				call("add_entries", {
					entries: UMLAUT_RECIPES.map((recipe) => ({ text_original: recipe })),
					fields: { title: "Suppen" },
				}),
			() => call("verify", { final: true }),
		];
		const h = await harness(
			(context) => {
				collect(replies, context);
				return (steps[replies.length] ?? (() => say("done")))();
			},
			{ out: join(root, "out"), schema: "RefRecipes", schemasDirs: [dir] },
		);
		const summary = await h.run("extract", [text]);
		expect(replies[0]).toMatch(/now has 3 entries \(added 3\)/);
		expect(summary.documents[0].committed + summary.documents[0].needsReview).toBe(1);
		const data = JSON.parse(readFileSync(join(root, "out", "kochbuch", "work", "units", "c0001.json"), "utf8"));
		expect(data.title).toBe("Suppen");
	}, 60_000);

	it("keeps a rejection pending until a call resolves it by ID, whatever the entries look like", async () => {
		const replies: string[] = [];
		// A valid entry with the same title as the rejected one must not settle the rejection.
		const sameTitle = { title_original: "Suppe", text_original: UMLAUT_RECIPES[0] };
		const bad = { title_original: "Suppe", text_original: 7 };
		const steps = [
			() => call("add_entries", { entries: [sameTitle, bad] }),
			() => call("add_entries", { entries: [{ title_original: "Suppe", text_original: UMLAUT_RECIPES[0] }] }),
			() => call("verify", { final: true }),
			() => call("add_entries", { remove: [2], entries: [entry(1)], resolves: ["R1"] }),
			() => call("add_entries", { resolves: ["R1"] }),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		expect(replies[0]).toMatch(/R1: entry 2 \(position 2\):/);
		expect(replies[1]).toMatch(/Pending rejections: R1\./);
		expect(replies[2]).toMatch(/^Not committed: add_entries rejections not resolved: R1 /);
		expect(replies[3]).toMatch(/resolved R1/);
		expect(replies[3]).not.toMatch(/Pending rejections/);
		expect(replies[4]).toMatch(/Nothing was changed: R1 is not a pending rejection of c0001 \(pending: none\)/);
		expect(summary.documents[0].committed).toBe(1);
		const state = JSON.parse(readFileSync(join(docDir, "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].issues?.some((issue) => issue.message.startsWith(PENDING_REJECTIONS_WARNING))).not.toBe(
			true,
		);
		const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		expect(data.entries).toEqual([sameTitle, entry(1)]);
	}, 60_000);

	it("keeps pending rejections across sessions", async () => {
		const replies: string[] = [];
		const bad = { title_original: "Suppe", text_original: 7 };
		const sequence = [
			() => call("add_entries", { entries: [entry(0), bad] }),
			// The agent stops without committing; the next session has a new extension.
			() => say("Done."),
			() => call("verify", { final: true }),
			() => call("add_entries", { entries: [entry(1)], resolves: ["R1"] }),
			() => call("add_entries", { entries: [entry(2)] }),
			() => call("verify", { final: true }),
		];
		let step = 0;
		const { summary, docDir, h } = await extractRun(
			(context) => {
				collect(replies, context);
				return (sequence[step++] ?? (() => say("done")))();
			},
			{ settleRetries: 0 },
		);
		expect(replies[0]).toMatch(/R1: entry 2 \(position 2\):/);
		expect(replies[1]).toMatch(/^Not committed: add_entries rejections not resolved: R1 /);
		expect(replies[2]).toMatch(/resolved R1/);
		expect(summary.documents[0].committed).toBe(1);
		const prompts = h.faux.requests.map((request) => request.messages.map(messageText).join("\n")).join("\n");
		expect(prompts).toMatch(/Pending add_entries rejections for c0001: R1 /);
		const state = JSON.parse(readFileSync(join(docDir, "run", "state.json"), "utf8")) as DocState;
		expect(state.units[0].rejections).toBeUndefined();
		expect(state.sessions.length).toBe(2);
		const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		expect(data.entries).toEqual([entry(0), entry(1), entry(2)]);
	}, 60_000);

	it("ignores bookkeeping keys the model sends itself", async () => {
		const replies: string[] = [];
		const steps = [
			() =>
				call("add_entries", {
					entries: UMLAUT_RECIPES.map((_, i) => entry(i)),
					rejected_entries: "not a list",
					rejected_fields: 5,
				}),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		expect(replies[0]).toMatch(/now has 3 entries \(added 3\)/);
		expect(replies[0]).not.toMatch(/rejected|fields not set/);
		expect(summary.documents[0].committed).toBe(1);
		const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		expect(data.entries).toHaveLength(3);
	}, 60_000);

	it("keeps the order for corrections and late resends with position", async () => {
		const replies: string[] = [];
		const wrong = { title_original: null, text_original: "Käsesuppe, falsch abgeschrieben." };
		const bad = { title_original: 3, text_original: UMLAUT_RECIPES[1] };
		const steps = [
			() => call("add_entries", { entries: [entry(0), wrong, entry(2)] }),
			// Correction in place: remove entry 2 and insert the fix at position 2.
			() => call("add_entries", { remove: [2], entries: [entry(1)], position: 2 }),
			() => call("add_entries", { remove: [2] }),
			// A rejected entry remembers its slot between Hühnerbrühe and Apfelküchlein.
			() => call("add_entries", { entries: [bad], position: 2 }),
			() => call("add_entries", { entries: [entry(1)], position: 2, resolves: ["R1"] }),
			() => call("verify", { final: true }),
		];
		const { summary, docDir } = await extractRun((context) => {
			collect(replies, context);
			return (steps[replies.length] ?? (() => say("done")))();
		});
		expect(replies[1]).toMatch(/Entries:\n1\. Hühnerbrühe.*\n2\. Käsesuppe\. Reibe.*\n3\. Apfelküchlein/);
		expect(replies[3]).toMatch(/R1: entry 1 \(position 2\)/);
		expect(replies[3]).toMatch(
			/1\. Hühnerbrühe.*\n {3}\[R1 belongs here: resend it with position=2\]\n2\. Apfelküchlein/,
		);
		// Slots move with removals before them and insertions strictly before them.
		expect(shiftSlot(3, [1], 3, 0)).toBe(2);
		expect(shiftSlot(2, [], 1, 1)).toBe(3);
		expect(shiftSlot(2, [], 2, 1)).toBe(2);
		expect(summary.documents[0].committed).toBe(1);
		const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
		expect(data.entries).toEqual([entry(0), entry(1), entry(2)]);
	}, 60_000);

	it.each([
		["the earlier rejection first", ["R1", "R2"]],
		["the later rejection first", ["R2", "R1"]],
	])(
		"keeps adjacent rejections in order when %s is resolved",
		async (_label, order) => {
			const replies: string[] = [];
			const bad = (i: number) => ({ title_original: 1, text_original: UMLAUT_RECIPES[i] });
			const fixFor: Record<string, number> = { R1: 0, R2: 1 };
			/** The slot the last result shows for a rejection. */
			const slotOf = (id: string) => {
				const match = new RegExp(`\\[${id} belongs here: resend it with position=(\\d+)\\]`).exec(
					replies[replies.length - 1],
				);
				return match ? Number(match[1]) : -1;
			};
			const steps = [
				() => call("add_entries", { entries: [bad(0), bad(1), entry(2)] }),
				...order.map(
					(id) => () =>
						call("add_entries", { entries: [entry(fixFor[id])], position: slotOf(id), resolves: [id] }),
				),
				() => call("verify", { final: true }),
			];
			const { summary, docDir } = await extractRun((context) => {
				collect(replies, context);
				return (steps[replies.length] ?? (() => say("done")))();
			});
			expect(replies[0]).toMatch(/R1: entry 1 \(position 1\)[\s\S]*R2: entry 2 \(position 1\)/);
			expect(summary.documents[0].committed).toBe(1);
			const data = JSON.parse(readFileSync(join(docDir, "run", "committed", "c0001.json"), "utf8"));
			expect(data.entries).toEqual([entry(0), entry(1), entry(2)]);
		},
		60_000,
	);

	it("finds the entries of a schema whose $refs chain through an alias", () => {
		const root = tempDir();
		writeFileSync(
			join(root, "chain.json"),
			JSON.stringify({
				name: "ChainRecipes",
				schema: {
					type: "object",
					properties: {
						contains_no_content_of_requested_type: { type: "boolean" },
						entries: { $ref: "#/$defs/alias" },
					},
					$defs: {
						alias: { $ref: "#/$defs/list" },
						list: { type: "array", items: { $ref: "#/$defs/entry" } },
						entry: {
							type: "object",
							properties: { text_original: { type: "string" } },
							required: ["text_original"],
							additionalProperties: false,
						},
					},
				},
			}),
		);
		const { setup, error } = resolveAddEntries(loadSchemaFile(join(root, "chain.json")));
		expect(error).toBeUndefined();
		expect(setup?.generic).toBe(false);
		expect(setup?.entryErrors({ text_original: "x" })).toEqual([]);
		expect(setup?.entryErrors({ recipe: "x" }).join(" ")).toMatch(/text_original/);
	});

	it("is not offered in transcription", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 1);
		const replies: string[] = [];
		const h = await harness(
			(context) => {
				collect(replies, context);
				if (replies.length === 0) return call("add_entries", { entries: [{ a: 1 }] });
				return diligent(context);
			},
			{ out: join(root, "out") },
		);
		const summary = await h.run("transcribe", [folder]);
		expect(summary.documents[0].committed).toBe(1);
		expect(replies[0]).toMatch(/not found|unknown|not available/i);
		expect(existsSync(join(root, "out", "pages", "work", "units", "p0001.json"))).toBe(false);
	}, 60_000);
});

describe("CLI contract", () => {
	const previousEnv = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
	let unregister: (() => void) | undefined;
	let responder: (context: TranscriptContext) => AssistantMessage = diligent;

	beforeAll(async () => {
		const agentDir = tempDir("mabillon-regressions-agent-");
		const registerFauxProvider = await loadRegisterFauxProvider();
		const faux = registerFauxProvider({ provider: "fauxreg", models: [{ id: "faux-1", input: ["text", "image"] }] });
		unregister = () => faux.unregister();
		faux.setResponses(Array.from({ length: 50 }, () => (context: TranscriptContext) => responder(context)));
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					fauxreg: {
						baseUrl: faux.models[0].baseUrl,
						api: faux.api,
						apiKey: "faux-key",
						models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }],
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_OFFLINE = "1";
	});

	afterAll(() => {
		unregister?.();
		if (previousEnv.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousEnv.agentDir;
		if (previousEnv.offline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousEnv.offline;
	});

	async function runCli(args: string[], beforeAwait?: () => void): Promise<{ code: number; stdout: string }> {
		let stdout = "";
		const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			return true;
		});
		try {
			const pending = cli(args);
			beforeAwait?.();
			return { code: await pending, stdout };
		} finally {
			spy.mockRestore();
		}
	}

	it("refuses unknown tools and a tool set without verify with exit code 2", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 1);
		const unknown = await runCli(["transcribe", folder, "--tools", "read,bogus,verify", "--json", "--quiet"]);
		expect(unknown.code).toBe(2);
		expect(JSON.parse(unknown.stdout).error).toMatch(/unknown tool bogus/);
		const noVerify = await runCli(["transcribe", folder, "--tools", "read,write", "--json", "--quiet"]);
		expect(noVerify.code).toBe(2);
		expect(JSON.parse(noVerify.stdout).error).toMatch(/must include verify/);
		const noView = await runCli(["transcribe", folder, "--tools", "write,verify", "--json", "--quiet"]);
		expect(noView.code).toBe(2);
		expect(JSON.parse(noView.stdout).error).toMatch(/view \(or python\) cannot be left out/);
	});

	it("reports files that are not UTF-8 as verification errors", async () => {
		const root = tempDir();
		const path = join(root, "c0001.json");
		writeFileSync(
			path,
			Buffer.from('{"contains_no_content_of_requested_type": true, "entries": [], "x": "Brühe"}', "latin1"),
		);
		const result = await runCli(["verify", path, "--schema", RECIPES_SCHEMA, "--json"]);
		expect(result.code).toBe(1);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.issues[0]).toMatchObject({ severity: "error", layer: "parse" });
		expect(parsed.issues[0].message).toMatch(/not valid UTF-8/);
	});

	it("prints one JSON object for --help --json", async () => {
		const result = await runCli(["--help", "--json"]);
		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed).toMatchObject({ ok: true, exit_code: 0 });
		expect(parsed.help).toMatch(/^Mabillon/);
	});

	it("exits 130 when interrupted before the first document", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "pages"), 1);
		const result = await runCli(
			["transcribe", folder, "--model", "fauxreg/faux-1", "--json", "--quiet", "--out", join(root, "out")],
			() => {
				// The run's own SIGINT handler (the last one registered); vitest's handlers are left alone.
				const handlers = process.listeners("SIGINT");
				(handlers[handlers.length - 1] as () => void)();
			},
		);
		expect(result.code).toBe(130);
		const parsed = JSON.parse(result.stdout);
		expect(parsed).toMatchObject({ ok: false, exit_code: 130, interrupted: true, documents: [] });
		expect(parsed.skipped[0].reason).toMatch(/not started: the run was interrupted/);
	});

	it("reports final validation errors in --json output and exits 1", async () => {
		const root = tempDir();
		const text = join(root, "notes.txt");
		writeFileSync(text, "Erstes Rezept. Take butter.\n");
		responder = (context) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "user" && currentUnit(context)) {
				const content = JSON.stringify({ contains_no_content_of_requested_type: false, entries: [{ bogus: 1 }] });
				return call("write", { path: "units/c0001.json", content });
			}
			return say("Done.");
		};
		const result = await runCli([
			"extract",
			text,
			"--schema",
			RECIPES_SCHEMA,
			"--model",
			"fauxreg/faux-1",
			"--settle-retries",
			"0",
			"--json",
			"--quiet",
			"--out",
			join(root, "out"),
		]);
		responder = diligent;
		expect(result.code).toBe(1);
		const document = JSON.parse(result.stdout).documents[0];
		expect(document.status).toBe("failed");
		expect(document.final_validation.length).toBeGreaterThan(0);
	}, 60_000);
});

describe("CLI process", () => {
	it("delivers large --json output completely through a pipe", () => {
		const root = tempDir();
		// Status of many runs produces JSON far beyond a pipe buffer.
		for (let i = 0; i < 1500; i++) {
			const runDir = join(root, `document_with_a_long_name_${String(i).padStart(4, "0")}`, "run");
			mkdirSync(runDir, { recursive: true });
			const units = Array.from({ length: 3 }, (_, u) => ({
				id: `p000${u + 1}`,
				index: u + 1,
				status: u === 2 ? "needs_review" : "committed",
				closedReason: u === 2 ? "tool budget of 40 calls exhausted" : undefined,
			}));
			writeFileSync(
				join(runDir, "state.json"),
				JSON.stringify({
					version: 2,
					mode: "transcribe",
					inputKind: "images",
					source: `/data/scans/document_with_a_long_name_${i}`,
					stem: `document_with_a_long_name_${i}`,
					schema: { name: "diplomatic_markdown_transcription", sha256: "x", path: "x" },
					units,
					sessions: [{ startedAt: "2026-01-01T00:00:00Z", units: [], cost: 0.01 }],
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
				}),
			);
		}
		const result = spawnSync(process.execPath, [join(process.cwd(), "src", "bin.ts"), "status", root, "--json"], {
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		expect(result.stdout.length).toBeGreaterThan(256 * 1024);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.ok).toBe(true);
		expect(parsed.documents).toHaveLength(1500);
		expect(parsed.documents[0].units_needs_review[0].reason).toMatch(/tool budget/);
		expect(result.status).toBe(0);
	}, 60_000);
});
