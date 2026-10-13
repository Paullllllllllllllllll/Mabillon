import { existsSync, lstatSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolName } from "../config.ts";
import { applyImageParams } from "../inputs/image-profile.ts";
import { type Box, describePrepared, ENHANCEMENTS, type Enhancement, loadRaw, prepareImage } from "../inputs/images.ts";
import { applyOpenRouterPreferences, servingProvider } from "../routing.ts";
import { boundaryPolicy, envelopeInfo } from "../schemas/registry.ts";
import { applyServiceTier } from "../service-tier.ts";
import { readUtf8File, writeFileAtomic } from "../util.ts";
import { formatIssues, type Issue } from "../verify/issues.ts";
import {
	buildGroundingSource,
	COVERAGE_WARNING,
	chunkCoverage,
	groundingIssues,
	MIN_COVERAGE_CHUNK,
} from "../verify/rules.ts";
import { type VerifyResult, verifyUnitContent } from "../verify/verify.ts";
import {
	type AddEntriesArgs,
	type EntryChange,
	entryIndex,
	PENDING_REJECTIONS_WARNING,
	partitionArguments,
	rejectionNumber,
	resolveAddEntries,
	shiftSlot,
	UPDATE_ENTRY_PARAMETERS,
	updateEntries,
	updateEntry,
} from "./add-entries.ts";
import { type MessageContent, stateSummary, unitContent, unitMarker } from "./messages.ts";
import {
	coverageRefusal,
	emptyContentRefusal,
	emptyDraftRefusal,
	notInContext,
	notUtf8Error,
	notUtf8Refusal,
	sanitizeBuiltinResult,
	softCapRefusal,
} from "./notices.ts";
import {
	CALL_SCRIPT,
	clearShown,
	describeShown,
	HELPER_NAME,
	installHelper,
	localPythonRunner,
	MAX_SHOWN_IMAGES,
	materializePage,
	plainDir,
	prepareShown,
	pythonEnvironment,
	SHOW_DIR,
	shownFiles,
	tail,
} from "./python-tool.ts";
import { committedPath, neighbor, type SessionRuntime } from "./runtime.ts";
import { sha256Text, type UnitRecord, unitFile } from "./state.ts";

export interface FinishedUnit {
	id: string;
	status: "committed" | "needs_review";
	reason?: string;
}

export interface ChronoExtensionHandle {
	factory: (pi: ExtensionAPI) => void;
	current(): UnitRecord | undefined;
	isDone(): boolean;
	markDelivered(unitId: string): void;
	/** Content for the session's first message; units that cannot be prepared are closed and skipped. */
	firstDelivery(preface: string): Promise<{ unit?: UnitRecord; content: MessageContent }>;
	/** Close the current unit for human review (used when the agent stops early) and move on. */
	closeCurrent(reason: string): void;
	/** Whether the agent made any tool call on this unit in this session. */
	workedOn(unitId: string): boolean;
	/** Units finished in this session, in order. */
	finished(): FinishedUnit[];
	/** Whether the extension itself ended the agent run (all units finished); not an error. */
	stoppedByHarness(): boolean;
	compactions(): number;
}

/** pi's default reserve for the model's response (settings compaction.reserveTokens). */
export const PI_RESERVE_TOKENS = 16_384;
const OMITTED_IMAGE = "[image of an earlier unit omitted to save context; view it again if needed]";
/** Regions one view call can show, and its largest magnification. */
export const MAX_VIEW_BOXES = 4;
export const MAX_VIEW_SCALE = 8;
const VIEW_BOX = {
	x: Type.Number({ minimum: 0, maximum: 1 }),
	y: Type.Number({ minimum: 0, maximum: 1 }),
	w: Type.Number({ minimum: 0, maximum: 1 }),
	h: Type.Number({ minimum: 0, maximum: 1 }),
};
const OMITTED_OLD_VIEW = "[older image omitted to stay within the provider's request limits; view again if needed]";

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/**
 * The normalization pi's file tools apply before resolving a path (pi utils/paths normalizePath with
 * stripAtPrefix): Unicode spaces, a leading "@", "~" for the home directory, file:// URLs, and on Windows
 * MSYS/WSL drive paths. The containment check must see the same path the tool will open.
 */
export function normalizeToolPath(input: string): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (process.platform === "win32" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")) {
		const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
		if (match) path = `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
	}
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		return join(homedir(), path.slice(2));
	}
	if (/^file:\/\//.test(path)) {
		try {
			return fileURLToPath(path);
		} catch {
			return path;
		}
	}
	return path;
}

/**
 * A work-relative path in the form the unit gate compares: Windows and macOS file systems ignore case, and
 * Windows also drops trailing dots and spaces of names, so `Source/c0009.txt` and `source./c0009.txt` open the
 * same file as `source/c0009.txt`.
 */
export function gatePath(rel: string, platform: NodeJS.Platform = process.platform): string {
	let path = rel;
	if (platform === "win32") {
		path = path
			.split("/")
			.map((part) => part.replace(/[. ]+$/, ""))
			.join("/");
	}
	return platform === "win32" || platform === "darwin" ? path.toLowerCase() : path;
}

/**
 * The file pi's read tool finally opens for an absolute path: when the path does not exist, pi tries macOS
 * variants (narrow space before AM/PM, NFD, curly apostrophe; pi tools/path-utils resolveReadPath), which apply
 * to the whole path and can therefore lead to another directory.
 */
export function readTarget(absolute: string): string {
	if (existsSync(absolute)) return absolute;
	const nfd = absolute.normalize("NFD");
	const variants = [
		absolute.replace(/ (AM|PM)\./gi, " $1."),
		nfd,
		absolute.replace(/'/g, "’"),
		nfd.replace(/'/g, "’"),
	];
	return variants.find((variant) => variant !== absolute && existsSync(variant)) ?? absolute;
}

type ContentBlock = TextContent | ImageContent;

function messageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => ((block as ContentBlock).type === "text" ? (block as TextContent).text : ""))
		.join("\n");
}

/**
 * Boundary compaction threshold: the configured size, but always leaving room below pi's own overflow compaction
 * (context window minus its reserve) for a whole unit of work with several images. A threshold of 0 compacts at
 * every unit boundary (each unit starts from the state summary).
 */
export function compactionThreshold(
	compactAt: number,
	contextWindow: number | undefined,
	reserveTokens = PI_RESERVE_TOKENS,
): number {
	if (!contextWindow || !Number.isFinite(contextWindow)) return compactAt;
	const headroom = Math.max(24_000, Math.round(contextWindow * 0.2));
	return Math.max(0, Math.min(compactAt, contextWindow - reserveTokens - headroom));
}

export function createChronoExtension(runtime: SessionRuntime): ChronoExtensionHandle {
	const { batch, config } = runtime;
	/** Whether the agent has this tool; messages mention only tools the agent has. */
	const has = (name: ToolName): boolean => runtime.tools.has(name);
	const omittedImage = has("view") ? OMITTED_IMAGE : "[image of an earlier unit omitted to save context]";
	const omittedOldView = has("view")
		? OMITTED_OLD_VIEW
		: "[older image omitted to stay within the provider's request limits]";
	let cursor = 0;
	let done = batch.length === 0;
	let pendingDelivery = false;
	let settleNudges = 0;
	let compactionCount = 0;
	/** Tool calls of the current turn that went through the tool_call hook (others failed before it). */
	let turnCallsSeen = 0;
	/** Set when the current unit must be closed for review at the end of the turn. */
	let closeRequested: string | undefined;
	/** The extension aborted the agent run because all units were finished. */
	let stoppedByHarness = false;
	/** Tool calls per unit in this session; caps apply per session so a resumed unit starts with a fresh budget. */
	const budget = new Map<string, number>();
	const delivered = new Set<string>();
	const lastReports = new Map<string, string>();
	const finishedUnits: FinishedUnit[] = [];

	const current = (): UnitRecord | undefined => (done ? undefined : batch[cursor]);
	const workReal = (() => {
		try {
			return realpathSync(runtime.workDir);
		} catch {
			return runtime.workDir;
		}
	})();
	/** The path relative to the work directory, resolved exactly as pi's tools resolve it; undefined if outside. */
	const insideWork = (path: string): string | undefined =>
		containedRel(resolve(runtime.workDir, normalizeToolPath(path)));
	/** An absolute path relative to the work directory (also after following symlinks); undefined if outside. */
	const containedRel = (absolute: string): string | undefined => {
		const rel = relative(runtime.workDir, absolute);
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
		// A symlink inside the work directory must not lead out of it, also for files that do not exist yet.
		let existing = absolute;
		let rest = "";
		while (!existsSync(existing) && existing !== dirname(existing)) {
			rest = rest ? join(basename(existing), rest) : basename(existing);
			existing = dirname(existing);
		}
		try {
			const real = relative(workReal, join(realpathSync(existing), rest));
			if (real === ".." || real.startsWith(`..${sep}`) || isAbsolute(real)) return undefined;
		} catch {
			return undefined;
		}
		return toPosix(rel);
	};
	const stem = runtime.state.stem;

	const advance = () => {
		cursor++;
		settleNudges = 0;
		closeRequested = undefined;
		if (cursor >= batch.length) {
			done = true;
			pendingDelivery = false;
		} else {
			pendingDelivery = true;
		}
	};

	const workPath = (unit: UnitRecord) => join(runtime.workDir, unitFile(runtime.mode, unit));

	// An extraction unit committed empty after a draft with entries was most likely emptied by mistake (seen live:
	// a model overwrote four drafted recipes with an empty envelope). Track the most entries any draft had.
	const entriesField = runtime.mode === "extract" ? envelopeInfo(runtime.schema.schema).entriesField : undefined;
	const fragments = runtime.mode === "extract" && boundaryPolicy(runtime.schema) === "fragments";
	// Shared by add_entries and update_entry; a schema the tools cannot be set up for runs without them (the driver
	// logs why).
	const entrySetup = runtime.mode === "extract" ? resolveAddEntries(runtime.schema).setup : undefined;
	const maxEntries = new Map<string, number>();
	/**
	 * Entries add_entries rejected, per unit: rejection ID (R1, R2, ...) to a short description. A rejection stays
	 * pending until a later call names it in `resolves` (seen live: a rejected entry was never resent and the unit
	 * was committed without it).
	 */
	// Kept in the unit's state record, so they survive a new session (early stop, provider retry, resume).
	const pendingRejections = (unit: UnitRecord): string[] =>
		(unit.rejections?.pending ?? []).map(
			(item) => `${item.id}${item.position === undefined ? "" : ` (position ${item.position})`} ${item.text}`,
		);
	/**
	 * Refuse-once guards: the turn in which a commit was refused, per unit. pi still runs later tool calls of the
	 * same assistant message after a refusal, so a confirmation counts only from a later turn (after the model has
	 * seen the refusal).
	 */
	const emptyChallenged = new Map<string, number>();
	const coverageChallenged = new Map<string, number>();
	const emptyContentChallenged = new Map<string, number>();
	/** Units whose source has enough content that an empty extraction needs confirming: every page, longer chunks. */
	const substantial = (unit: UnitRecord): boolean =>
		runtime.inputKind === "images" || runtime.sources.text(unit).trim().length >= MIN_COVERAGE_CHUNK;
	const rejectedChallenged = new Map<string, number>();
	let turn = 0;
	/** Whether a commit must be refused now; records the refusal. */
	const refuseNow = (challenged: Map<string, number>, unitId: string): boolean => {
		const refusedIn = challenged.get(unitId);
		if (refusedIn !== undefined && refusedIn < turn) return false;
		challenged.set(unitId, refusedIn ?? turn);
		return true;
	};
	const entryCount = (content: string): number => {
		if (!entriesField) return 0;
		try {
			const value = (JSON.parse(content) as Record<string, unknown> | null)?.[entriesField];
			return Array.isArray(value) ? value.length : 0;
		} catch {
			return 0;
		}
	};
	const noteEntries = (unit: UnitRecord, content: string | undefined) => {
		if (!entriesField || content === undefined) return;
		const count = entryCount(content);
		if (count > (maxEntries.get(unit.id) ?? 0)) maxEntries.set(unit.id, count);
	};

	/** Units whose file, at its last read, was not valid UTF-8 (e.g. written by a script in cp1252). */
	const notUtf8 = new Set<string>();
	const readUnit = (unit: UnitRecord): string | undefined => {
		const path = workPath(unit);
		if (!existsSync(path)) return undefined;
		const { text, valid } = readUtf8File(path);
		if (valid) notUtf8.delete(unit.id);
		else notUtf8.add(unit.id);
		return text;
	};

	/** Keep the canonical copy outside the agent's reach; outputs and handoffs read only these. */
	const storeCommitted = (unit: UnitRecord, content: string | undefined) => {
		if (content === undefined) {
			rmSync(committedPath(runtime, unit), { force: true });
			unit.contentHash = undefined;
			return;
		}
		// Exactly the content that was verified and hashed, written atomically.
		writeFileAtomic(committedPath(runtime, unit), content);
		unit.contentHash = sha256Text(content);
	};

	const groundingText = (unit: UnitRecord): string | undefined => {
		if (runtime.inputKind !== "text") return undefined;
		// Entries may be completed from the following chunks (look-ahead), so ground against those too.
		return [unit, neighbor(runtime, unit, 1), neighbor(runtime, unit, 2)]
			.filter((candidate): candidate is UnitRecord => candidate !== undefined)
			.map((candidate) => runtime.sources.text(candidate))
			.join("\n");
	};

	const runVerify = (unit: UnitRecord, content: string): VerifyResult => {
		const result = verifyUnitContent({
			schema: runtime.schema,
			content,
			sourceText: groundingText(unit),
			chunkText: runtime.inputKind === "text" ? runtime.sources.text(unit) : undefined,
			groundingThreshold: config.groundingThreshold,
		});
		if (!notUtf8.has(unit.id)) return result;
		const issue: Issue = {
			severity: "error",
			layer: "parse",
			message: notUtf8Error(runtime.tools, unitFile(runtime.mode, unit)),
		};
		return { ...result, issues: [issue, ...result.issues], errors: result.errors + 1 };
	};

	const unitStats = (unit: UnitRecord): string => {
		const parts = [`${budget.get(unit.id) ?? 0} tool calls`];
		if (runtime.inputKind === "images") parts.push(`${unit.views ?? 0} views`);
		parts.push(`${unit.verifyRuns ?? 0} verify runs`);
		return parts.join(", ");
	};

	const commit = (unit: UnitRecord, content: string, warnings: Issue[], carryOver: string | undefined) => {
		storeCommitted(unit, content);
		unit.status = "committed";
		unit.issues = warnings.length > 0 ? warnings : undefined;
		// Schemas that record page-local fragments have no carry-over: the next unit records its own part.
		unit.carryOver = carryOver?.trim() && !fragments ? carryOver.trim() : undefined;
		unit.closedReason = undefined;
		// Unresolved rejections are kept as a warning issue; the open list ends with the commit.
		unit.rejections = undefined;
		unit.committedAt = new Date().toISOString();
		// The session (model, thinking, tools) that committed the unit.
		unit.session = runtime.state.sessions.length || undefined;
		if (runtime.reviewStreak) runtime.reviewStreak.count = 0;
		finishedUnits.push({ id: unit.id, status: "committed" });
		runtime.persist();
		const warningNote = warnings.length > 0 ? `, ${warnings.length} warning(s)` : "";
		runtime.log(`${stem} ${unit.id} committed (${unitStats(unit)}${warningNote})`);
	};

	const closeForReview = (unit: UnitRecord, reason: string) => {
		const content = readUnit(unit);
		const issues: Issue[] = content
			? runVerify(unit, content).issues
			: [{ severity: "error", layer: "process", message: "no unit file was written" }];
		storeCommitted(unit, content);
		unit.status = "needs_review";
		unit.issues = issues;
		unit.closedReason = reason;
		unit.committedAt = new Date().toISOString();
		unit.session = runtime.state.sessions.length || undefined;
		if (runtime.reviewStreak) runtime.reviewStreak.count++;
		finishedUnits.push({ id: unit.id, status: "needs_review", reason });
		runtime.persist();
		runtime.log(`${stem} ${unit.id} closed for review: ${reason} (${unitStats(unit)})`);
	};

	/**
	 * Too many consecutive units closed for review (counted across sessions): the session ends at this unit boundary,
	 * and the driver stops the document.
	 */
	const stopOnReviewStreak = (): boolean => {
		const streak = runtime.reviewStreak;
		if (!streak || streak.count < streak.limit) return false;
		done = true;
		pendingDelivery = false;
		return true;
	};

	/** Content that hands the current unit to the agent; units that cannot be prepared are closed and skipped. */
	const nextDelivery = async (options: {
		withContextImages: boolean;
		preface?: string;
	}): Promise<{ unit?: UnitRecord; content: MessageContent }> => {
		for (;;) {
			const unit = current();
			if (!unit) {
				return {
					content: [{ type: "text", text: "All units of this session are finished. Stop now." }],
				};
			}
			try {
				const content = await unitContent(runtime, unit, options);
				delivered.add(unit.id);
				// A unit closed above (could not be prepared) set pendingDelivery; this unit is being delivered now.
				pendingDelivery = false;
				return { unit, content };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				closeForReview(unit, `the unit could not be prepared: ${message}`);
				advance();
				if (stopOnReviewStreak()) {
					return {
						content: [
							{
								type: "text",
								text: "Several units in a row were closed for review; this session ends. Stop now.",
							},
						],
					};
				}
			}
		}
	};

	const factory = (pi: ExtensionAPI) => {
		const verifyTool = defineTool({
			name: "verify",
			label: "Verify",
			description:
				"Check the current unit file (parsing, JSON Schema, consistency rules, suspicious repetitions, verbatim grounding for text sources). Without final it only reports. With final=true it commits the unit when there are no errors; the next unit is then delivered in a new message.",
			parameters: Type.Object({
				final: Type.Optional(
					Type.Boolean({ description: "Commit the current unit if verification finds no errors." }),
				),
				carry_over: Type.Optional(
					Type.String({
						description: fragments
							? "Not used with this schema: entries crossing a unit boundary are recorded in each unit as fragments."
							: "Extraction only, with final=true: describe text at the start of the next unit(s) that belongs to an entry already recorded in this unit (quote where it ends). Those units will skip it.",
					}),
				),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				const unit = current();
				if (!unit) {
					return {
						content: [{ type: "text", text: "All units of this session are finished. Stop now." }],
						details: undefined,
						terminate: true,
					};
				}
				const file = unitFile(runtime.mode, unit);
				const content = readUnit(unit);
				if (content === undefined) {
					return {
						content: [{ type: "text", text: `${file} does not exist yet. Write it first.` }],
						details: undefined,
						isError: true,
					};
				}
				unit.verifyRuns = (unit.verifyRuns ?? 0) + 1;
				const result = runVerify(unit, content);
				const issues = [...result.issues];
				const entries = entryCount(content);
				const earlier = maxEntries.get(unit.id) ?? 0;
				noteEntries(unit, content);
				const unresolved = pendingRejections(unit);
				const rejectedWarning: Issue | undefined =
					unresolved.length > 0 && has("add_entries")
						? {
								severity: "warning",
								layer: "process",
								message: `${PENDING_REJECTIONS_WARNING}: ${unresolved.join("; ")}. Resend each corrected with add_entries and resolves=["R…"], or drop it with resolves alone`,
							}
						: undefined;
				if (rejectedWarning) issues.push(rejectedWarning);
				if (params.final && entries === 0 && earlier > 0) {
					if (refuseNow(emptyChallenged, unit.id)) {
						return {
							content: [
								{
									type: "text",
									text: emptyDraftRefusal(runtime.tools, file, unit.id, earlier),
								},
							],
							details: { unit: unit.id, errors: 1, warnings: 0, committed: false },
							isError: true,
						};
					}
					issues.push({
						severity: "warning",
						layer: "process",
						message: `committed without entries although an earlier draft in this session had ${earlier}; confirmed by the agent`,
					});
				} else if (params.final && entriesField && entries === 0 && substantial(unit)) {
					// An empty extraction of a page, or of a chunk with real text, needs a second look before it is final.
					if (refuseNow(emptyContentChallenged, unit.id)) {
						return {
							content: [
								{
									type: "text",
									text: emptyContentRefusal(file, runtime.inputKind),
								},
							],
							details: { unit: unit.id, errors: 1, warnings: 0, committed: false },
							isError: true,
						};
					}
					issues.push({
						severity: "warning",
						layer: "process",
						message: "committed without entries; confirmed by the agent after a second look",
					});
				}
				if (params.final && !delivered.has(unit.id)) {
					issues.push({
						severity: "error",
						layer: "process",
						message: notInContext(runtime.inputKind, unit.id, runtime.tools),
					});
				}
				const errors = issues.filter((issue) => issue.severity === "error");
				const warnings = issues.filter((issue) => issue.severity === "warning");
				const report = formatIssues(issues);
				lastReports.set(unit.id, report);
				if (!params.final) {
					return {
						content: [
							{
								type: "text",
								text: `Verification of ${file}: ${errors.length} error(s), ${warnings.length} warning(s).\n${report}${
									errors.length > 0
										? ""
										: warnings.length > 0
											? "\nResolve or knowingly accept the warnings above before committing; verify final=true is irreversible."
											: "\nNo errors: commit with verify final=true when you are satisfied."
								}`,
							},
						],
						details: { unit: unit.id, errors: errors.length, warnings: warnings.length, committed: false },
					};
				}
				if (errors.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `NOT COMMITTED: ${file} has ${errors.length} error(s).\n${report}\nFix the errors and call verify with final=true again.`,
							},
						],
						details: { unit: unit.id, errors: errors.length, warnings: warnings.length, committed: false },
						isError: true,
					};
				}
				// Models treat final=true as a routine step even right after a missing-entries warning (seen live:
				// one of four recipes committed). The first such commit is refused; a second call confirms.
				const coverage = warnings.find((issue) => issue.message.startsWith(COVERAGE_WARNING));
				if (coverage && refuseNow(coverageChallenged, unit.id)) {
					return {
						content: [
							{
								type: "text",
								text: coverageRefusal(runtime.tools, file, coverage.message),
							},
						],
						details: { unit: unit.id, errors: 0, warnings: warnings.length, committed: false },
						isError: true,
					};
				}
				if (rejectedWarning && refuseNow(rejectedChallenged, unit.id)) {
					return {
						content: [
							{
								type: "text",
								text: `Not committed: ${rejectedWarning.message}. Commit is final and the next unit follows; to commit with these rejections unresolved, call verify final=true again.`,
							},
						],
						details: { unit: unit.id, errors: 0, warnings: warnings.length, committed: false },
						isError: true,
					};
				}
				commit(unit, content, warnings, params.carry_over);
				advance();
				const next = current();
				const warningText = warnings.length > 0 ? ` with ${warnings.length} warning(s) noted` : "";
				return {
					content: [
						{
							type: "text",
							text: next
								? `Committed ${unit.id}${warningText}. The next unit, ${next.id}, follows in the next message; do not start it before it arrives.`
								: `Committed ${unit.id}${warningText}. All units of this session are committed. Stop now.`,
						},
					],
					details: { unit: unit.id, errors: 0, warnings: warnings.length, committed: true },
					terminate: next === undefined,
				};
			},
		});

		pi.registerTool(verifyTool);

		if (entrySetup && has("add_entries")) {
			const setup = entrySetup;
			pi.registerTool(
				defineTool({
					name: "add_entries",
					label: "Add entries",
					description: `Change the current unit's file units/<id>.json (created with the schema's envelope if missing) without resending or reading it: \`remove\` deletes entries by their number in the file, \`entries\` appends new entries (1-3 per call, in source order), \`fields\` sets the other top-level fields, \`resolves\` settles earlier rejections. Each new entry is checked against the schema's entry structure; invalid ones are not added and get a rejection ID (R1, R2, ...). A rejection stays pending until a later call names it in \`resolves\`, with the corrected entry in \`entries\` or alone to drop it. Every result ends with a numbered index of the file's entries.${
						setup.generic ? " Each entry is an object with the fields of the schema's entries." : ""
					}`,
					parameters: setup.parameters as unknown as ReturnType<typeof Type.Object>,
					prepareArguments: (args: unknown) => partitionArguments(setup, args) as never,
					executionMode: "sequential",
					async execute(_toolCallId, params) {
						const unit = current();
						if (!unit) {
							return {
								content: [{ type: "text", text: "All units of this session are finished. Stop now." }],
								details: undefined,
								terminate: true,
							};
						}
						const args = params as unknown as AddEntriesArgs;
						const file = unitFile(runtime.mode, unit);
						const added = args.entries ?? [];
						const rejected = args.rejected_entries ?? [];
						const remove = args.remove ?? [];
						const resolves = [...new Set((args.resolves ?? []).map((id) => id.trim().toUpperCase()))];
						const fail = (text: string) => ({
							content: [{ type: "text" as const, text }],
							details: undefined,
							isError: true,
						});
						if (
							added.length === 0 &&
							rejected.length === 0 &&
							!args.fields &&
							!args.rejected_fields &&
							remove.length === 0 &&
							resolves.length === 0
						) {
							return fail("Nothing to do: pass at least one of entries, fields, remove, or resolves.");
						}
						const before = unit.rejections ?? { next: 1, pending: [] };
						const unknown = resolves.filter((id) => !before.pending.some((item) => item.id === id));
						if (unknown.length > 0) {
							const open = before.pending.map((item) => item.id);
							return fail(
								`Nothing was changed: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a pending rejection of ${unit.id} (pending: ${open.length > 0 ? open.join(", ") : "none"}).`,
							);
						}
						const existing = readUnit(unit);
						if (existing !== undefined && notUtf8.has(unit.id)) {
							return fail(notUtf8Refusal(runtime.tools, file, "add_entries"));
						}
						const changesFile = added.length > 0 || args.fields !== undefined || remove.length > 0;
						const result = updateEntries(setup, existing, {
							remove,
							entries: added,
							fields: args.fields,
							position: args.position,
						});
						if (!result.data) return fail(`${file} ${result.error}. Nothing was changed.`);
						// All bookkeeping is prepared before the file is written, so no error can follow a partial change.
						const insertedAt = result.insertedAt ?? 1;
						const removedNumbers = [...new Set(remove)];
						let next = before.next;
						// A rejected entry's slot: where it would have been inserted among this call's valid entries.
						const newIds = rejected.map((item) => {
							const validBefore =
								item.position - 1 - rejected.filter((other) => other.position < item.position).length;
							return { id: `R${next++}`, item, position: insertedAt + validBefore };
						});
						// Slots (after this call's removals) of the rejections this call resolves: a later rejection of the
						// same slot comes after the corrected entry, an earlier one stays before it.
						const resolvedAt = before.pending
							.filter((item) => resolves.includes(item.id) && item.position !== undefined)
							.map((item) => ({
								slot: shiftSlot(item.position as number, removedNumbers, insertedAt, 0),
								number: rejectionNumber(item.id),
							}));
						const pending = [
							...before.pending
								.filter((item) => !resolves.includes(item.id))
								.map((item) => {
									if (item.position === undefined) return item;
									const slot = shiftSlot(item.position, removedNumbers, insertedAt, 0);
									const follows = resolvedAt.some(
										(resolved) => resolved.slot === slot && resolved.number < rejectionNumber(item.id),
									);
									return {
										...item,
										position: shiftSlot(item.position, removedNumbers, insertedAt, added.length, follows),
									};
								}),
							...newIds.map(({ id, item, position }) => ({
								id,
								text: `(entry ${item.position} of an earlier call, '${setup.entryLabel(item.entry)}': ${item.errors.join("; ")})`,
								position,
							})),
						];
						const text = changesFile ? `${JSON.stringify(result.data, null, 2)}\n` : undefined;
						if (text !== undefined) {
							writeFileAtomic(workPath(unit), text);
							noteEntries(unit, text);
						}
						unit.rejections = pending.length > 0 || next > 1 ? { next, pending } : undefined;
						runtime.persist();
						const record = { pending: new Map(pending.map((item) => [item.id, item.text])) };
						const total = (result.data[setup.entriesField] as unknown[]).length;
						const summary = [
							`added ${added.length}`,
							...(remove.length > 0 ? [`removed ${new Set(remove).size}`] : []),
							...(rejected.length > 0 ? [`rejected ${rejected.length}`] : []),
							...(resolves.length > 0 ? [`resolved ${resolves.join(", ")}`] : []),
						];
						const parts = [
							`${file} ${changesFile ? "now has" : "has"} ${total} entries (${summary.join(", ")}).`,
						];
						if (newIds.length > 0) {
							parts.push(
								`Rejected (not added; resend each corrected with resolves=["<id>"] and the position shown, or drop it with resolves alone):\n${newIds
									.map(
										({ id, item, position }) =>
											`${id}: entry ${item.position} (position ${position}): ${item.errors.join("; ")}`,
									)
									.join("\n")}`,
							);
						}
						if (args.rejected_fields?.length) {
							parts.push(`fields not set: ${args.rejected_fields.join("; ")}`);
						}
						const earlier = [...record.pending.keys()].filter((id) => !newIds.some((item) => item.id === id));
						if (earlier.length > 0) parts.push(`Pending rejections: ${earlier.join(", ")}.`);
						if (runtime.inputKind === "text") {
							const share = chunkCoverage(result.data, runtime.schema, runtime.sources.text(unit));
							if (share !== undefined) {
								parts.push(
									`The entries' verbatim fields cover ${Math.round(share * 100)}% of the chunk text; add the entries still missing, then verify.`,
								);
							}
						}
						parts.push(
							entryIndex(
								setup,
								result.data,
								pending.flatMap((item) =>
									item.position === undefined ? [] : [{ id: item.id, position: item.position }],
								),
							),
						);
						return {
							content: [{ type: "text", text: parts.join("\n") }],
							details: { unit: unit.id, added: added.length, rejected: rejected.length, total },
							isError: !changesFile && resolves.length === 0,
						};
					},
				}),
			);
		}

		if (entrySetup && has("update_entry")) {
			const setup = entrySetup;
			pi.registerTool(
				defineTool({
					name: "update_entry",
					label: "Update entry",
					description:
						"Change fields of one entry of the current unit file by its number (see the entry index), without resending it: each change sets a JSON pointer within the entry to a value. The changed entry is checked against the schema's entry structure; if it does not match, nothing changes. Use it to fix single fields, e.g. after a grounding warning.",
					parameters: UPDATE_ENTRY_PARAMETERS as unknown as ReturnType<typeof Type.Object>,
					executionMode: "sequential",
					async execute(_toolCallId, params) {
						const unit = current();
						if (!unit) {
							return {
								content: [{ type: "text", text: "All units of this session are finished. Stop now." }],
								details: undefined,
								terminate: true,
							};
						}
						const args = params as unknown as { number: number; changes: EntryChange[] };
						const file = unitFile(runtime.mode, unit);
						const existing = readUnit(unit);
						if (existing !== undefined && notUtf8.has(unit.id)) {
							return {
								content: [
									{
										type: "text",
										text: notUtf8Refusal(runtime.tools, file, "update_entry"),
									},
								],
								details: undefined,
								isError: true,
							};
						}
						const changes = args.changes ?? [];
						const result = updateEntry(setup, existing, args.number, changes);
						if (!result.data) {
							return {
								content: [
									{
										type: "text",
										text: `Entry ${args.number} of ${file} was not changed:\n${(result.errors ?? []).map((error) => `- ${error}`).join("\n")}`,
									},
								],
								details: undefined,
								isError: true,
							};
						}
						const text = `${JSON.stringify(result.data, null, 2)}\n`;
						writeFileAtomic(workPath(unit), text);
						noteEntries(unit, text);
						const parts = [`${file}: entry ${args.number} updated (${changes.length} change(s)).`];
						if (runtime.inputKind === "text") {
							// Grounding of the changed entry's verbatim fields, so a fix can be checked at once.
							const grounding = groundingIssues(
								{ [setup.entriesField]: [result.entry] },
								runtime.schema,
								buildGroundingSource(groundingText(unit) ?? ""),
								config.groundingThreshold,
							);
							for (const issue of grounding) {
								const where = (issue.pointer ?? "").replace(`/${setup.entriesField}/0`, "") || "/";
								parts.push(`${issue.severity.toUpperCase()} ${where}: ${issue.message}`);
							}
							const share = chunkCoverage(result.data, runtime.schema, runtime.sources.text(unit));
							if (share !== undefined) {
								parts.push(`The entries' verbatim fields cover ${Math.round(share * 100)}% of the chunk text.`);
							}
						}
						const slots = (unit.rejections?.pending ?? []).flatMap((item) =>
							item.position === undefined ? [] : [{ id: item.id, position: item.position }],
						);
						parts.push(entryIndex(setup, result.data, slots));
						return {
							content: [{ type: "text", text: parts.join("\n") }],
							details: { unit: unit.id, entry: args.number, changes: changes.length },
						};
					},
				}),
			);
		}

		if (runtime.inputKind === "images" && has("view")) {
			const enhancement = Type.Union(ENHANCEMENTS.map((name) => Type.Literal(name)));
			const viewTool = defineTool({
				name: "view",
				label: "View",
				description: `Show a page image: a region at full resolution (box), or up to ${MAX_VIEW_BOXES} regions in one call (boxes, one image each), optionally magnified, enhanced, rotated, or with a coordinate grid; or the whole page. Available pages: the current page, the previous page and the next page. The current page is already attached to the unit message.`,
				parameters: Type.Object({
					unit: Type.Optional(Type.String({ description: "Page id, e.g. p0007. Default: the current page." })),
					box: Type.Optional(
						Type.Object(VIEW_BOX, {
							description:
								"Region as fractions of the page: x, y = top-left corner; w, h = width and height. {x:0, y:0, w:0.5, h:0.5} is the top-left quarter.",
						}),
					),
					boxes: Type.Optional(
						Type.Array(Type.Object(VIEW_BOX), {
							minItems: 1,
							maxItems: MAX_VIEW_BOXES,
							description: `Up to ${MAX_VIEW_BOXES} regions (as box) shown in one call, one image each, in the order given; the other options apply to each. Use instead of box, e.g. for consecutive bands of a page.`,
						}),
					),
					scale: Type.Optional(
						Type.Number({
							minimum: 0.25,
							maximum: MAX_VIEW_SCALE,
							description: `Extra magnification of the region, up to ${MAX_VIEW_SCALE}x (default: small regions are enlarged up to 3x). The model's image size limit can lower it.`,
						}),
					),
					rotate: Type.Optional(Type.Number({ description: "Clockwise rotation in degrees, e.g. 90." })),
					enhance: Type.Optional(
						Type.Array(enhancement, { description: "Image enhancements applied in this order." }),
					),
					grid: Type.Optional(
						Type.Boolean({ description: "Overlay a labelled grid in page coordinates to help choose boxes." }),
					),
				}),
				async execute(_toolCallId, params) {
					const active = current();
					if (!active) {
						return {
							content: [{ type: "text", text: "All units of this session are finished. Stop now." }],
							details: undefined,
							terminate: true,
						};
					}
					const allowed = [active, neighbor(runtime, active, -1), neighbor(runtime, active, 1)].filter(
						(unit): unit is UnitRecord => unit !== undefined,
					);
					const target = params.unit ? allowed.find((unit) => unit.id === params.unit) : active;
					if (!target) {
						return {
							content: [
								{
									type: "text",
									text: `Page ${params.unit} is not available. You can view: ${allowed.map((unit) => unit.id).join(", ")}.`,
								},
							],
							details: undefined,
							isError: true,
						};
					}
					if (params.box && params.boxes) {
						return {
							content: [{ type: "text", text: "Pass either box or boxes, not both." }],
							details: undefined,
							isError: true,
						};
					}
					const regions: Array<Box | undefined> = params.boxes ?? [params.box];
					// A batch must fit next to the images every request keeps (context images and the unit's page);
					// otherwise the context hook, which keeps the newest images first, would drop its first regions.
					const profile = runtime.imageProfile;
					const keptBytes =
						runtime.contextImages.reduce((sum, context) => sum + context.image.data.length, 0) +
						(runtime.pageImageBytes ?? 0);
					const slots = Math.max(1, profile.maxRequestImages - runtime.contextImages.length - 1);
					if (regions.length > slots) {
						return {
							content: [
								{
									type: "text",
									text: `At most ${slots} region(s) fit into one request next to the page for this model; view fewer boxes per call.`,
								},
							],
							details: undefined,
							isError: true,
						};
					}
					active.views = (active.views ?? 0) + regions.length;
					const plain =
						!params.box &&
						!params.boxes &&
						!params.enhance?.length &&
						!params.rotate &&
						!params.grid &&
						!params.scale;
					if (plain && target.id === active.id && delivered.has(active.id)) {
						return {
							content: [
								{
									type: "text",
									text: `The full page ${active.id} is already in the conversation (attached to the unit message), at the highest resolution the model accepts. Use box or boxes to zoom into regions, or enhance, rotate or grid.`,
								},
							],
							details: { unit: target.id, box: params.box, boxes: undefined as number | undefined },
						};
					}
					const { key, loader } = runtime.sources.image(target);
					const content: Array<TextContent | ImageContent> = [];
					let batchBytes = 0;
					for (const [index, region] of regions.entries()) {
						const image = await prepareImage(key, loader, {
							box: region,
							scale: params.scale,
							rotate: params.rotate,
							enhance: params.enhance as Enhancement[] | undefined,
							grid: params.grid,
							limits: runtime.imageProfile,
						});
						const label =
							regions.length > 1
								? `Page ${target.id}, region ${index + 1} of ${regions.length}`
								: `Page ${target.id}`;
						content.push({ type: "text", text: describePrepared(label, image) });
						content.push({ type: "image", data: image.data, mimeType: image.mimeType });
						batchBytes += image.data.length;
					}
					if (regions.length > 1 && keptBytes + batchBytes > profile.maxRequestImageBytes) {
						return {
							content: [
								{
									type: "text",
									text: `These ${regions.length} regions together exceed the image data one request can carry for this model; view fewer or smaller regions per call, or a lower scale.`,
								},
							],
							details: undefined,
							isError: true,
						};
					}
					if (target.id === active.id && !params.box && !params.boxes) delivered.add(active.id);
					return {
						content,
						details: { unit: target.id, box: params.box, boxes: params.boxes?.length },
					};
				},
			});
			pi.registerTool(viewTool);
		}

		if (runtime.inputKind === "images" && has("python")) {
			installHelper(runtime.workDir);
			const runner = runtime.pythonRunner ?? localPythonRunner;
			pi.registerTool(
				defineTool({
					name: "python",
					label: "Python",
					description: `Run a Python script on the page images, with the work directory as the current directory. The current page is the file in the environment variable MABILLON_PAGE (source/<id>.png, full resolution, lossless); the previous and next pages are in MABILLON_PREVIOUS_PAGE and MABILLON_NEXT_PAGE. scratch/${HELPER_NAME} is a helper module you can import and change. Images the script saves to ${SHOW_DIR}/ (emptied before every call) are shown to you, at most ${MAX_SHOWN_IMAGES} per call, never enlarged: scale them yourself. stdout and stderr are returned.${runtime.config.pythonSandbox ? " The script runs in a sandbox: no network access, and it can write only under scratch/." : ""}`,
					parameters: Type.Object({
						code: Type.String({ description: "The Python script." }),
					}),
					executionMode: "sequential",
					async execute(_toolCallId, params, signal) {
						const active = current();
						if (!active) {
							return {
								content: [{ type: "text", text: "All units of this session are finished. Stop now." }],
								details: undefined,
								terminate: true,
							};
						}
						const pages: Record<"current" | "previous" | "next", UnitRecord | undefined> = {
							current: active,
							previous: neighbor(runtime, active, -1),
							next: neighbor(runtime, active, 1),
						};
						const relPaths: { current: string; previous?: string; next?: string } = {
							current: `source/${active.id}.png`,
						};
						for (const [role, unit] of Object.entries(pages)) {
							if (!unit) continue;
							const rel = `source/${unit.id}.png`;
							const { key, loader } = runtime.sources.image(unit);
							await materializePage(join(runtime.workDir, rel), key, loader);
							relPaths[role as "current" | "previous" | "next"] = rel;
						}
						// Also as a file: a sandboxed interpreter may start with a fresh environment.
						writeFileAtomic(join(runtime.workDir, "source", "pages.json"), `${JSON.stringify(relPaths)}\n`);
						try {
							clearShown(runtime.workDir);
							plainDir(runtime.workDir, "scratch/tmp");
							// A link in place of the script would send Mabillon's write elsewhere; it is removed, not followed.
							const script = join(runtime.workDir, CALL_SCRIPT);
							if (lstatSync(script, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(script);
							writeFileAtomic(script, params.code);
						} catch (error) {
							return {
								content: [{ type: "text", text: `The script was not run: ${(error as Error).message}.` }],
								details: undefined,
								isError: true,
							};
						}
						const run = await runner({
							python: runtime.config.pythonPath,
							args: ["-X", "utf8", CALL_SCRIPT],
							cwd: runtime.workDir,
							env: pythonEnvironment(runtime.workDir, relPaths),
							timeoutMs: runtime.config.pythonTimeout * 1000,
							signal,
						});
						const blocks: Array<TextContent | ImageContent> = [];
						const lines = [
							run.timedOut
								? `Stopped after ${runtime.config.pythonTimeout} s (time limit).`
								: `Exit code ${run.exitCode}.`,
						];
						let files: string[] = [];
						try {
							files = shownFiles(runtime.workDir);
						} catch (error) {
							lines.push(`No images shown: ${(error as Error).message}.`);
						}
						if (run.stdout.trim()) lines.push(`stdout:\n${tail(run.stdout)}`);
						if (run.stderr.trim()) lines.push(`stderr:\n${tail(run.stderr)}`);
						const shown = files.slice(0, MAX_SHOWN_IMAGES);
						const images: Array<{ name: string; image: Awaited<ReturnType<typeof prepareShown>> }> = [];
						for (const name of shown) {
							try {
								images.push({
									name,
									image: await prepareShown(join(runtime.workDir, SHOW_DIR, name), runtime.imageProfile),
								});
							} catch (error) {
								lines.push(`${SHOW_DIR}/${name} could not be read as an image: ${(error as Error).message}`);
							}
						}
						if (files.length > shown.length) {
							lines.push(
								`Only the first ${MAX_SHOWN_IMAGES} images (in name order) are shown; not shown: ${files.slice(MAX_SHOWN_IMAGES).join(", ")}.`,
							);
						}
						if (images.length > 0) active.views = (active.views ?? 0) + images.length;
						if (!has("view") && images.length > 0) {
							// Without view, an image of the page's full size puts the whole page back into the context.
							const { key, loader } = runtime.sources.image(active);
							const page = await loadRaw(key, loader);
							if (
								images.some(
									({ image }) => image.sourceWidth === page.width && image.sourceHeight === page.height,
								)
							) {
								delivered.add(active.id);
							}
						}
						blocks.push({ type: "text", text: lines.join("\n") });
						for (const { name, image } of images) {
							blocks.push({ type: "text", text: describeShown(name, image) });
							blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
						}
						return {
							content: blocks,
							details: {
								unit: active.id,
								exitCode: run.exitCode,
								timedOut: run.timedOut,
								images: images.length,
							},
							isError: run.timedOut || run.exitCode !== 0,
						};
					},
				}),
			);
		}

		// pi's built-in tools may suggest tools the agent does not have (read: "Use bash: sed ..."); such hints are
		// rewritten so that tool ablations differ in the tool set alone.
		pi.on("tool_result", (event) => {
			if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return undefined;
			let changed = false;
			const content = event.content.map((block) => {
				if (block.type !== "text") return block;
				const text = sanitizeBuiltinResult(runtime.tools, block.text);
				if (text === block.text) return block;
				changed = true;
				return { ...block, text };
			});
			return changed ? { content } : undefined;
		});

		pi.on("before_provider_request", (event) => {
			applyImageParams(event.payload, runtime.imageProfile);
			applyOpenRouterPreferences(event.payload, runtime.routing);
			applyServiceTier(event.payload, runtime.serviceTier);
			return event.payload;
		});

		pi.on("provider_stream_event", (event) => {
			if (!runtime.routing) return;
			const provider = servingProvider(event.data);
			if (provider) runtime.servedBy?.add(provider);
		});

		// Keep requests small: images of earlier units are replaced by a note, and within the current unit the oldest
		// views are dropped first when the provider's per-request image limits would be exceeded. Context images and
		// the current page stay. The stored session is not changed.
		pi.on("context", (event) => {
			const unit = current();
			if (!unit) return undefined;
			const marker = unitMarker(unit);
			const messages = event.messages;
			let start = -1;
			for (let i = messages.length - 1; i >= 0; i--) {
				const role = (messages[i] as { role?: string }).role;
				if ((role === "user" || role === "custom") && messageText(messages[i]).includes(marker)) {
					start = i;
					break;
				}
			}
			if (start < 0) return undefined;
			const keep = new Set(runtime.contextImages.map((context) => context.image.data));
			const profile = runtime.imageProfile;
			// Images of the current unit, newest first; the unit's own page (first image at `start`) is protected.
			const candidates: Array<{ message: number; block: number; size: number }> = [];
			let protectedBytes = 0;
			let protectedCount = 0;
			let pageProtected = false;
			for (let i = start; i < messages.length; i++) {
				const content = (messages[i] as { content?: unknown }).content;
				if (!Array.isArray(content)) continue;
				content.forEach((block: ContentBlock, b) => {
					if (block.type !== "image") return;
					if (keep.has(block.data) || (!pageProtected && i === start)) {
						if (!keep.has(block.data)) pageProtected = true;
						protectedBytes += block.data.length;
						protectedCount++;
					} else {
						candidates.push({ message: i, block: b, size: block.data.length });
					}
				});
			}
			const drop = new Set<string>();
			let bytes = protectedBytes;
			let count = protectedCount;
			for (const candidate of [...candidates].reverse()) {
				if (bytes + candidate.size > profile.maxRequestImageBytes || count + 1 > profile.maxRequestImages) {
					drop.add(`${candidate.message}:${candidate.block}`);
				} else {
					bytes += candidate.size;
					count++;
				}
			}
			let changed = false;
			const result = messages.map((message, i) => {
				const content = (message as { content?: unknown }).content;
				if (!Array.isArray(content)) return message;
				let touched = false;
				const blocks = content.map((block: ContentBlock, b) => {
					if (block.type !== "image" || keep.has(block.data)) return block;
					if (i < start) {
						touched = true;
						return { type: "text", text: omittedImage } as TextContent;
					}
					if (drop.has(`${i}:${b}`)) {
						touched = true;
						return { type: "text", text: omittedOldView } as TextContent;
					}
					return block;
				});
				if (!touched) return message;
				changed = true;
				return { ...message, content: blocks } as typeof message;
			});
			return changed ? { messages: result } : undefined;
		});

		pi.on("tool_call", async (event) => {
			const toolName = event.toolName;
			const input = (event.input ?? {}) as Record<string, unknown>;
			const unit = current();
			if (!unit) {
				return { block: true, reason: "All units of this session are finished. Stop now.", terminate: true };
			}
			if (pendingDelivery) {
				return {
					block: true,
					reason: `Unit ${unit.id} has not been delivered yet. Stop calling tools; it arrives in the next message.`,
				};
			}
			turnCallsSeen++;
			const used = (budget.get(unit.id) ?? 0) + 1;
			budget.set(unit.id, used);
			unit.toolCalls = (unit.toolCalls ?? 0) + 1;
			const isLast = cursor === batch.length - 1;
			if (closeRequested || used > config.toolHardCap) {
				closeRequested ??= `tool budget of ${config.toolHardCap} calls exhausted`;
				return {
					block: true,
					reason: `The tool budget for ${unit.id} is exhausted. The unit is closed with its current file and flagged for human review. ${
						isLast
							? "This was the last unit of the session. Stop now."
							: "The next unit follows in the next message."
					}`,
					terminate: isLast,
				};
			}
			const path = typeof input.path === "string" ? input.path : undefined;
			let rel = path === undefined ? undefined : insideWork(path);
			if (toolName === "read" && rel !== undefined) {
				// pi's read tool falls back to variants of a missing path; check the file it would actually open.
				const checked = resolve(runtime.workDir, rel);
				const target = readTarget(checked);
				if (target !== checked) rel = containedRel(target);
			}
			// Hand pi the checked path, so that no later normalization can make it point elsewhere.
			if (rel !== undefined && (toolName === "read" || toolName === "write" || toolName === "edit")) {
				input.path = `./${rel}`;
			}
			if ((toolName === "read" || toolName === "write" || toolName === "edit") && path !== undefined && !rel) {
				return {
					block: true,
					reason: "Only files inside the work directory are accessible (units/, notes.md, scratch/, source/).",
				};
			}
			const key = rel === undefined ? undefined : gatePath(rel);
			const unitKey = gatePath(unitFile(runtime.mode, unit));
			const ownFile = key === unitKey || key === "notes.md";
			const rereadsUnit =
				!delivered.has(unit.id) &&
				((toolName === "view" &&
					!input.box &&
					!input.boxes &&
					(input.unit === undefined || input.unit === unit.id)) ||
					(toolName === "read" && key === gatePath(`source/${unit.id}.txt`)));
			if (
				used > config.toolSoftCap &&
				(toolName === "view" || toolName === "read" || toolName === "bash" || toolName === "python") &&
				!ownFile &&
				!rereadsUnit
			) {
				// Recorded, so that units shaped by the budget can be told apart in the outputs.
				unit.softCapBlocks = (unit.softCapBlocks ?? 0) + 1;
				return {
					block: true,
					reason: softCapRefusal(runtime.tools, unit.id, config.toolSoftCap),
				};
			}
			if (toolName === "read" && key?.startsWith("source/")) {
				const id = basename(key, extname(key));
				// Text units may look two chunks ahead (long entries).
				const allowedIds = [
					unit,
					neighbor(runtime, unit, -1),
					neighbor(runtime, unit, 1),
					neighbor(runtime, unit, 2),
				]
					.filter((candidate): candidate is UnitRecord => candidate !== undefined)
					.map((candidate) => candidate.id);
				if (!allowedIds.some((allowed) => gatePath(allowed) === id)) {
					return {
						block: true,
						reason: `${id} is not available. You can read: ${allowedIds.map((allowed) => `source/${allowed}.txt`).join(", ")}.`,
					};
				}
				// Re-reading the whole current chunk puts its text back into context (e.g. after compaction).
				if (id === gatePath(unit.id) && input.offset === undefined && input.limit === undefined) {
					delivered.add(unit.id);
				}
			}
			if ((toolName === "write" || toolName === "edit") && key !== undefined) {
				const target = unitFile(runtime.mode, unit);
				if (key === unitKey) {
					// The draft about to be replaced, and the new content.
					noteEntries(unit, readUnit(unit));
					if (typeof input.content === "string") noteEntries(unit, input.content);
				}
				if (key !== unitKey && key !== "notes.md" && !key.startsWith("scratch/")) {
					return {
						block: true,
						reason: `You can only write ${target} (the current unit), notes.md, or files under scratch/. Committed units are final.`,
					};
				}
			}
			return undefined;
		});

		pi.on("turn_end", async (event, ctx) => {
			turn++;
			const wasDone = done;
			// Tool calls that failed before the tool_call hook (invalid arguments, output cut off by the token limit)
			// still count against the unit's budget, so a model that keeps failing cannot loop forever.
			const unseen = Math.max(0, event.toolResults.length - turnCallsSeen);
			turnCallsSeen = 0;
			const active = current();
			if (active && !pendingDelivery) noteEntries(active, readUnit(active));
			if (active && !pendingDelivery && unseen > 0) {
				const used = (budget.get(active.id) ?? 0) + unseen;
				budget.set(active.id, used);
				active.toolCalls = (active.toolCalls ?? 0) + unseen;
				if (used > config.toolHardCap) closeRequested ??= `tool budget of ${config.toolHardCap} calls exhausted`;
			}
			let closedNow = false;
			if (active && !pendingDelivery && closeRequested) {
				// Every close request comes from the exhausted tool budget: a censored unit.
				active.hardCapClosed = true;
				closeForReview(active, closeRequested);
				advance();
				stopOnReviewStreak();
				closedNow = true;
			}
			if (done) {
				// Every unit is finished, but the model is still calling tools. Calls that fail validation never reach
				// the tool_call hook and its stop hint, so end the run here.
				if (event.toolResults.length > 0 && (wasDone || closedNow) && !stoppedByHarness) {
					stoppedByHarness = true;
					ctx.abort();
				}
				return undefined;
			}
			if (!pendingDelivery) return undefined;
			return deliverNext(ctx);
		});

		const deliverNext = async (ctx: ExtensionContext) => {
			const usage = ctx.getContextUsage();
			const threshold = compactionThreshold(
				config.compactAtTokens,
				ctx.model?.contextWindow ?? usage?.contextWindow,
				runtime.reserveTokens,
			);
			const tokens = usage?.tokens ?? 0;
			const entries: Array<
				| { type: "compaction"; summary: string; firstKeptEntryId: null }
				| { type: "custom_message"; customType: string; content: MessageContent; display: boolean }
			> = [];
			const upcoming = current();
			let compacted = false;
			if (upcoming && tokens >= threshold) {
				entries.push({
					type: "compaction",
					summary: stateSummary(runtime, upcoming, false),
					firstKeptEntryId: null,
				});
				delivered.clear();
				compactionCount++;
				compacted = true;
				runtime.log(`${stem} context compacted at ${tokens.toLocaleString("en-US")} tokens before ${upcoming.id}`);
			}
			pendingDelivery = false;
			const { content } = await nextDelivery({ withContextImages: compacted });
			entries.push({ type: "custom_message", customType: "mabillon-unit", content, display: true });
			return { entries, continue: true };
		};

		pi.on("agent_before_settle", async (event, ctx) => {
			if (pendingDelivery) return deliverNext(ctx);
			const unit = current();
			if (!unit || event.outcome !== "completed") return undefined;
			if (settleNudges >= config.settleRetries) return undefined;
			settleNudges++;
			const remaining = batch.slice(cursor).map((candidate) => candidate.id);
			const report = lastReports.get(unit.id);
			const text = [
				`You stopped, but ${unit.id} is not committed and ${remaining.length} unit(s) of this session remain (${remaining.join(", ")}).`,
				report ? `Last verify report for ${unit.id}:\n${report}` : undefined,
				`Continue: finish ${unitFile(runtime.mode, unit)} and call verify with final=true. Do not stop before the session's units are committed.`,
			]
				.filter(Boolean)
				.join("\n\n");
			return {
				entries: [{ type: "custom_message", customType: "mabillon-nudge", content: text, display: true }],
				continue: true,
			};
		});

		// pi's own compaction (context overflow in the middle of a unit) gets the same deterministic summary instead
		// of a model-written one; the unit is then shown again so the agent can finish it.
		pi.on("session_before_compact", async (event) => ({
			compaction: {
				summary: stateSummary(runtime, current(), true),
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));

		pi.on("session_compact", async () => {
			compactionCount++;
			const unit = current();
			runtime.log(`${stem} context compacted by pi during ${unit?.id ?? "session end"}`);
			if (!unit || pendingDelivery) return;
			delivered.clear();
			const { content } = await nextDelivery({
				withContextImages: true,
				preface: `The conversation was compacted while you were working on ${unit.id}; the unit is shown again. Your draft, if any, is in ${unitFile(runtime.mode, unit)}.`,
			});
			pi.sendMessage({ customType: "mabillon-unit", content, display: true }, { deliverAs: "steer" });
		});
	};

	return {
		factory,
		current,
		isDone: () => done,
		markDelivered: (unitId) => delivered.add(unitId),
		firstDelivery: (preface) => nextDelivery({ withContextImages: true, preface }),
		closeCurrent: (reason) => {
			const unit = current();
			if (!unit) return;
			closeForReview(unit, reason);
			advance();
			pendingDelivery = false;
			stopOnReviewStreak();
		},
		workedOn: (unitId) => (budget.get(unitId) ?? 0) > 0,
		finished: () => [...finishedUnits],
		stoppedByHarness: () => stoppedByHarness,
		compactions: () => compactionCount,
	};
}
