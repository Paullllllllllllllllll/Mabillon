import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	resolveCliModel,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { resolveAddEntries } from "./agent/add-entries.ts";
import { createChronoExtension, type FinishedUnit } from "./agent/extension.ts";
import type { MessageContent } from "./agent/messages.ts";
import { sessionIntro } from "./agent/messages.ts";
import { buildSystemPrompt } from "./agent/prompts.ts";
import { bundledHelperSha256, localPythonRunner, type PythonRunner, pythonEnvironment } from "./agent/python-tool.ts";
import { readCommitted, type SessionRuntime, type UnitSources } from "./agent/runtime.ts";
import { checkSandbox, resetSandbox, sandboxedPythonRunner } from "./agent/sandbox.ts";
import {
	acquireLock,
	type DocPaths,
	type DocState,
	docPaths,
	type ExperimentRecord,
	type InputKind,
	imageListFingerprint,
	isDone,
	loadState,
	type SessionRecord,
	type SourceFingerprint,
	saveState,
	sha256File,
	sha256Text,
	type UnitRecord,
	unitFile,
	unitsDigest,
} from "./agent/state.ts";
import {
	type ChronoPlan,
	ChronoSync,
	createRegistry,
	documentTextPath,
	MABILLON_DIR,
	planDocument,
	renderWithoutStore,
	type StoreRegistry,
	staleError,
} from "./chrono/document.ts";
import { type DraftsStore, findDrafts, rangesText, resolveDrafts, seedDrafts } from "./chrono/drafts.ts";
import { realPath } from "./chrono/paths.ts";
import { ChronoStore, DATABASE_NAMES } from "./chrono/store.ts";
import {
	type ChronoConfig,
	checkToolSet,
	DEFAULT_CONFIG,
	effectiveTools,
	type Mode,
	outputSettings,
	TOOL_NAMES,
	type ToolName,
} from "./config.ts";
import { type ContextBundle, checkContextFiles, resolveContext } from "./context.ts";
import { assignStems, discoverDocuments, OUTPUT_DIR_NAME, type SourceDocument } from "./inputs/discover.ts";
import { downgradeProfile, type ImageProfile, resolveImageProfile, withMaxEdge } from "./inputs/image-profile.ts";
import { clearImageCache, fileLoader, type PreparedImage, prepareContextImage } from "./inputs/images.ts";
import { PdfSource } from "./inputs/pdf.ts";
import {
	checkLineLengths,
	chunksFromLineRanges,
	chunkText,
	lineRangeIssues,
	loadTextDocument,
	type TextChunk,
} from "./inputs/text.ts";
import { tiffSubfileTypes } from "./inputs/tiff.ts";
import { type OutputPaths, type StoreRecord, writeOutputs } from "./outputs.ts";
import { describePreferences, effectiveRouting, openRouterPreferences, withOpenRouterRouting } from "./routing.ts";
import { boundaryPolicy, envelopeInfo, type LoadedSchema, resolveSchema } from "./schemas/registry.ts";
import {
	checkServiceTierRoute,
	FLEX_TIMEOUT_MS,
	isOpenAIResponses,
	retryDelaysFor,
	withServiceTier,
} from "./service-tier.ts";
import {
	canonicalPath,
	ensureDir,
	errorMessage,
	formatUnitId,
	parseSelection,
	readPackageVersion,
	unitWidth,
	writeFileAtomic,
} from "./util.ts";

export interface RunServices {
	modelRuntime?: ModelRuntime;
	/** pi agent directory with auth.json, models.json, settings.json. Default: ~/.pi/agent (shared with pi). */
	agentDir?: string;
	/** Settings to use instead of the agent directory's settings.json (tests). */
	settings?: Record<string, unknown>;
	/** Waits between retries after transient provider errors, in ms (tests shorten them). */
	retryDelays?: number[];
	/** Shell lookup for the bash tool (tests inject a missing shell). Default: findBashShell. */
	findShell?: (configured: string | undefined) => { available: boolean; path?: string };
	/** Runner for the python tool's scripts (tests inject a fake). Default: the local interpreter. */
	pythonRunner?: PythonRunner;
}

const NO_SHELL_MESSAGE =
	"The bash tool was requested (--bash or in --tools), but no bash shell was found: pi searches Git Bash under Program Files and bash.exe on PATH, and Mabillon also a per-user Git install. Set shellPath in pi's settings.json (~/.pi/agent) or leave bash out.";

export interface RunOptions {
	mode: Mode;
	inputs: string[];
	config: ChronoConfig;
	log: (message: string) => void;
	signal?: AbortSignal;
	services?: RunServices;
}

export interface DocumentResult {
	stem: string;
	source: string;
	/** Folder of the rendered files and the sidecar. */
	outputDir: string;
	/** Mabillon's working folder of the document, `<output root>/.mabillon/<document name>/`. */
	workingDir?: string;
	outputs?: OutputPaths;
	/** Units in the document and in the --units selection. */
	units: number;
	selected: number;
	committed: number;
	needsReview: number;
	/** Units closed for human review, with the reason. */
	reviewUnits: Array<{ unit: string; reason?: string }>;
	/** Selected units that are not finished. */
	pending: number;
	cost: number;
	/** Problems noticed while preparing the document (encoding, line ranges) or resuming it (reopened units). */
	warnings?: string[];
	/** The agent's tools in the latest session. */
	tools?: string[];
	/** Schema errors of the merged extraction output; the document counts as failed. */
	finalValidation?: string[];
	error?: string;
	/** An error that stops the whole run (credentials, missing model). */
	fatal?: boolean;
}

export interface RunSummary {
	documents: DocumentResult[];
	skipped: Array<{ path: string; reason: string }>;
	/** Set when a fatal error (credentials, missing model) stopped the run early. */
	fatalError?: string;
}

/** An error that no later session or document can recover from. */
export class FatalRunError extends Error {}

const MAX_STALLED_SESSIONS = 3;
const REVIEW_STREAK_LIMIT = 3;
const DEFAULT_RETRY_DELAYS = [15_000, 30_000, 60_000, 120_000];
const PLAIN_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown"]);

export type DocumentStatusLabel = "complete" | "needs_review" | "incomplete" | "failed";

export function documentStatus(doc: DocumentResult): DocumentStatusLabel {
	if (doc.error) return "failed";
	if (doc.pending > 0) return "incomplete";
	// The merged output does not validate against the schema.
	if (doc.finalValidation?.length) return "failed";
	return doc.needsReview > 0 ? "needs_review" : "complete";
}

/** Exit code of a run: interrupted, credentials, failures/incomplete, review, success (in that precedence). */
export function runExitCode(documents: DocumentResult[], interrupted: boolean, fatal: boolean): number {
	if (interrupted) return 130;
	if (fatal) return 2;
	const statuses = documents.map(documentStatus);
	if (statuses.some((status) => status === "failed" || status === "incomplete")) return 1;
	if (statuses.includes("needs_review")) return 3;
	return 0;
}

function documentLabel(doc: SourceDocument): string {
	const kind = doc.kind === "pdf" ? "PDF" : doc.kind === "images" ? "image folder" : "text document";
	return `"${basename(doc.path)}" (${kind})`;
}

export type ProviderErrorKind = "auth" | "quota" | "routing" | "transient" | "other";

// OpenRouter finds no endpoint that meets the routing preferences (zero data retention, providers, quantizations).
const ROUTING_ERROR =
	/no endpoints? found|no allowed providers|no providers? (are )?available|data policy|zero data retention|\bzdr\b/i;

// Quota and subscription limits reset after hours; retrying within a run does not help.
const QUOTA_ERROR =
	/insufficient_quota|exceeded your current quota|quota exceeded|out of budget|billing|usage.?limit|UsageLimitError|subscription_sharing_usage_limit_exceeded|available balance|credit balance/i;
const AUTH_ERROR =
	/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^.]{0,40}(api[ _-]?key|x-api-key|token|credential)|authenticat|not logged in|no api key|api key (is )?(missing|required)|security token|UnrecognizedClient|permission denied|expired (token|session)/i;
// pi's own retryable patterns (pi-ai utils/retry.ts) plus a few transport errors.
const TRANSIENT_ERROR =
	/\b(408|409|425|429|500|502|503|504|520|522|524|529)\b|overloaded|high demand|rate.?limit|too many requests|capacity|temporarily|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(error|refused|lost|reset)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? ?out|timeout|terminated|websocket.?(closed|error)|ended without|stream ended before|did not get a response|retry delay|retry your request|try (your request )?again|unavailable/i;

/** Seconds from a "retry in 23.5s" / "try again in ~180 min" hint in an error message. */
function retryHintSeconds(message: string): number | undefined {
	const match =
		/(?:retry|try again)[^.\d]{0,20}?~?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i.exec(
			message,
		);
	if (!match) return undefined;
	const value = Number.parseFloat(match[1]);
	const unit = match[2].toLowerCase();
	if (unit.startsWith("ms") || unit.startsWith("milli")) return value / 1000;
	if (unit.startsWith("s")) return value;
	if (unit.startsWith("m")) return value * 60;
	return value * 3600;
}

/** Classify a provider error message: credentials, quota or routing (stop the run), transient (retry), or other. */
export function classifyProviderError(message: string): ProviderErrorKind {
	if (ROUTING_ERROR.test(message)) return "routing";
	if (QUOTA_ERROR.test(message)) {
		// Per-minute quotas (Gemini RESOURCE_EXHAUSTED, OpenAI TPM/RPM) reset quickly and say so.
		const wait = retryHintSeconds(message);
		if (wait !== undefined ? wait <= 600 : /per.?minute|PerMinute|\b(TPM|RPM)\b|rate.?limit/i.test(message)) {
			return "transient";
		}
		return "quota";
	}
	if (AUTH_ERROR.test(message)) return "auth";
	if (TRANSIENT_ERROR.test(message)) return "transient";
	return "other";
}

/** Provider errors that reject the image parameters or sizes rather than the agent's work. */
export function isImageRequestError(error: string): boolean {
	if (classifyProviderError(error) !== "other") return false;
	const mentionsImages =
		/input_image|image_url|inline_?data|\bimages?\b|media.?resolution|\bdetail\b[^.]{0,60}\b(original|high|low|auto)\b/i;
	const rejects =
		/\b(400|413|422)\b|invalid|unsupported|not supported|too (large|big|many)|exceed|dimension|pixels|bad request/i;
	// An oversized request body comes from the images; hosts rarely say so.
	const oversized = /\b413\b|payload too large|request entity too large|request body (is )?too large/i;
	return (mentionsImages.test(error) && rejects.test(error)) || oversized.test(error);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done);
	});
}

function lineRangesFile(doc: SourceDocument): string | undefined {
	if (!PLAIN_TEXT_EXTENSIONS.has(extname(doc.path).toLowerCase())) return undefined;
	const path = join(dirname(doc.path), `${basename(doc.path, extname(doc.path))}_line_ranges.txt`);
	return existsSync(path) ? path : undefined;
}

function sourceFingerprint(doc: SourceDocument, config: ChronoConfig): SourceFingerprint {
	if (doc.kind === "images") return { source: imageListFingerprint(doc.images ?? []) };
	const fingerprint: SourceFingerprint = { source: sha256File(doc.path) };
	if (doc.kind === "text") {
		fingerprint.chunkTokens = config.chunkTokens;
		const ranges = lineRangesFile(doc);
		if (ranges) fingerprint.lineRanges = sha256File(ranges);
	}
	return fingerprint;
}

/** Convert a text document and split it into chunks (ChronoMiner line ranges if present). */
async function convertText(
	doc: SourceDocument,
	config: ChronoConfig,
	warn: (message: string) => void,
	log: (message: string) => void,
	draftRanges?: Array<[number, number]>,
): Promise<{ chunks: TextChunk[]; lines: string[]; documentText: string; uncovered?: string[] }> {
	const { text, warning } = await loadTextDocument(doc.path);
	if (warning) warn(warning);
	let { chunks, lines } = chunkText(text, config.chunkTokens);
	if (draftRanges) {
		// ChronoMiner's lines (`read_lines`): split at "\n", a final line end opens no line, trailing blank lines
		// count. A chunk range outside them cannot be reproduced and is refused, not clipped.
		lines = text === "" ? [] : text.split("\n");
		if (text.endsWith("\n")) lines.pop();
		const outside = draftRanges.find(([start, end]) => start < 1 || start > end || end > lines.length);
		if (outside) {
			throw new Error(
				`the drafts document's chunk ${outside[0]}-${outside[1]} lies outside the ${lines.length} lines of ${basename(doc.path)}`,
			);
		}
	}
	checkLineLengths(lines, config.chunkTokens);
	let uncovered: string[] | undefined;
	// ChronoMiner line ranges (e.g. after its semantic boundary adjustment) apply to plain-text files, whose line
	// numbering the conversion keeps; in correction mode the chunks of the drafts document take their place.
	const file = lineRangesFile(doc);
	const ranges = draftRanges
		? { name: "the ChronoMiner chunks of the drafts document", text: rangesText(draftRanges) }
		: file
			? { name: basename(file), text: readFileSync(file, "utf8") }
			: undefined;
	if (ranges) {
		const ranged = chunksFromLineRanges(lines, ranges.text);
		if (ranged.length > 0) {
			chunks = ranged;
			log(`${doc.stem}: using ${ranged.length} line ranges from ${ranges.name}`);
			const issues = lineRangeIssues(ranged, lines.length);
			// Lines in no range would silently be left out of the extraction.
			const gaps = issues.filter((issue) => issue.endsWith("in no range"));
			if (gaps.length > 0 && !config.allowPartialRanges) {
				throw new Error(
					`${ranges.name} leaves source lines out (${gaps.join("; ")}); fix the ranges, or pass --allow-partial-ranges to extract only the covered lines`,
				);
			}
			if (gaps.length > 0) uncovered = gaps;
			for (const issue of issues) warn(`${ranges.name}: ${issue}`);
		} else {
			warn(`${ranges.name} contains no line ranges; chunking automatically`);
		}
	}
	return { chunks, lines, documentText: `${lines.join("\n")}\n`, uncovered };
}

/**
 * Resuming a text document: the conversion must give the same text and chunks, and the stored copies in run/text/
 * must be unchanged; otherwise the committed units would not match the text the agent is shown and grounded on.
 */
async function checkStoredText(doc: SourceDocument, config: ChronoConfig, paths: DocPaths, existing: DocState) {
	const quiet = () => undefined;
	// A correction run keeps the chunk ranges of its drafts document.
	const draftRanges = existing.drafts?.ranges
		? existing.units.map((unit): [number, number] => [unit.startLine ?? 0, unit.endLine ?? 0])
		: undefined;
	const { chunks, documentText } = await convertText(doc, config, quiet, quiet, draftRanges);
	const refuse = (problem: string) => {
		throw new Error(`Existing work cannot be resumed: ${problem}. Use --force to start over.`);
	};
	const recorded = existing.fingerprint.text;
	if (recorded !== undefined && recorded !== sha256Text(documentText)) {
		refuse("the converted text differs from the text the run was started with (converter or settings changed)");
	}
	const stored = documentTextPath(paths.runDir, basename(doc.path));
	if (!existsSync(stored) || (recorded !== undefined && sha256Text(readFileSync(stored, "utf8")) !== recorded)) {
		refuse(`the stored document text in ${relative(paths.docDir, stored)} is missing or was changed`);
	}
	if (chunks.length !== existing.units.length) refuse("the document now splits into a different number of chunks");
	existing.units.forEach((unit, i) => {
		const chunk = chunks[i];
		const file = join(paths.textDir, `${unit.id}.txt`);
		if (chunk.startLine !== unit.startLine || chunk.endLine !== unit.endLine) {
			refuse(`the line range of ${unit.id} changed`);
		}
		if (!existsSync(file) || readFileSync(file, "utf8") !== chunk.text) {
			refuse(`the stored text of ${unit.id} in run/text/ is missing or differs from the document`);
		}
	});
}

/** Create the unit list of a new run. Text documents also get their converted text and chunks stored in run/text/. */
async function buildUnits(
	doc: SourceDocument,
	paths: DocPaths,
	config: ChronoConfig,
	pdf: PdfSource | undefined,
	fingerprint: SourceFingerprint,
	warn: (message: string) => void,
	log: (message: string) => void,
	draftRanges?: Array<[number, number]>,
): Promise<{ units: UnitRecord[]; totalLines?: number; uncovered?: string[] }> {
	if (doc.kind === "pdf" && pdf) {
		const width = unitWidth(pdf.numPages);
		const units = Array.from({ length: pdf.numPages }, (_, i) => ({
			id: formatUnitId("p", i + 1, width),
			index: i + 1,
			status: "pending" as const,
			pdfPage: i + 1,
		}));
		return { units };
	}
	if (doc.kind === "images") {
		// Multi-page TIFFs contribute one unit per page; reduced-resolution copies of a page (pyramid levels,
		// thumbnails), which the file marks as such, are skipped.
		const pages: Array<{ image: string; imagePage?: number }> = [];
		for (const image of doc.images ?? []) {
			const ext = extname(image).toLowerCase();
			const count = ext === ".tif" || ext === ".tiff" ? ((await sharp(image).metadata()).pages ?? 1) : 1;
			if (count <= 1) {
				pages.push({ image });
				continue;
			}
			const types = tiffSubfileTypes(image);
			let reduced = 0;
			for (let page = 0; page < count; page++) {
				if (page > 0 && types && ((types[page] ?? 0) & 1) === 1) {
					reduced++;
					continue;
				}
				pages.push({ image, imagePage: page });
			}
			if (reduced > 0) {
				warn(`${basename(image)}: skipped ${reduced} reduced-resolution copies (pyramid levels or thumbnails)`);
			}
		}
		const width = unitWidth(pages.length);
		return {
			units: pages.map((page, i) => ({
				id: formatUnitId("p", i + 1, width),
				index: i + 1,
				status: "pending" as const,
				...page,
			})),
		};
	}
	const { chunks, lines, documentText, uncovered } = await convertText(doc, config, warn, log, draftRanges);
	fingerprint.text = sha256Text(documentText);
	const textPath = documentTextPath(paths.runDir, basename(doc.path));
	ensureDir(dirname(textPath));
	writeFileAtomic(textPath, documentText);
	const width = unitWidth(chunks.length);
	const units = chunks.map((chunk) => {
		const unit: UnitRecord = {
			id: formatUnitId("c", chunk.index, width),
			index: chunk.index,
			status: "pending",
			startLine: chunk.startLine,
			endLine: chunk.endLine,
		};
		writeFileAtomic(join(paths.textDir, `${unit.id}.txt`), chunk.text);
		return unit;
	});
	return { units, totalLines: lines.length, uncovered };
}

function createSources(
	paths: DocPaths,
	state: DocState,
	config: ChronoConfig,
	pdf: PdfSource | undefined,
): UnitSources {
	const textCache = new Map<string, string>();
	const text = (unit: UnitRecord) => {
		let value = textCache.get(unit.id);
		if (value === undefined) {
			value = readFileSync(join(paths.textDir, `${unit.id}.txt`), "utf8");
			textCache.set(unit.id, value);
		}
		return value;
	};
	return {
		totalLines: state.totalLines,
		image(unit) {
			if (unit.pdfPage && pdf) {
				const page = unit.pdfPage;
				return {
					key: `${state.source}#${page}@${config.dpi}:${config.maxRenderPixels}`,
					loader: () => pdf.renderRaw(page, config.dpi, config.maxRenderPixels),
				};
			}
			if (!unit.image) throw new Error(`No image available for ${unit.id}`);
			return { key: `${unit.image}#${unit.imagePage ?? 0}`, loader: fileLoader(unit.image, unit.imagePage) };
		},
		text,
		materialize(unit) {
			// Only chunks within the agent's reach exist in work/source; later ones stay in run/text.
			ensureDir(join(paths.workDir, "source"));
			for (const offset of [-1, 0, 1, 2]) {
				const candidate = state.units.find((other) => other.index === unit.index + offset);
				if (candidate) writeChunk(paths, candidate, text(candidate));
			}
		},
	};
}

/** Write a chunk into work/source unless the file there already has exactly this text. */
function writeChunk(paths: DocPaths, unit: UnitRecord, content: string): boolean {
	const target = join(paths.workDir, "source", `${unit.id}.txt`);
	if (existsSync(target) && readFileSync(target, "utf8") === content) return false;
	writeFileAtomic(target, content);
	return true;
}

/**
 * At session start, restore every chunk in work/source from run/text (checked on resume), so that a chunk changed
 * in work/ (e.g. through bash) cannot reach the agent as source text.
 */
function refreshSources(ctx: DocumentContext): void {
	const { paths, state, sources } = ctx;
	if (state.inputKind !== "text") return;
	for (const unit of state.units) {
		if (!existsSync(join(paths.workDir, "source", `${unit.id}.txt`))) continue;
		if (writeChunk(paths, unit, sources.text(unit))) {
			ctx.options.log(`${state.stem}: source/${unit.id}.txt differed from the document text; restored`);
		}
	}
}

/** Restore committed unit files the agent changed afterwards (e.g. through bash); the committed copy is canonical. */
function restoreCommitted(paths: DocPaths, state: DocState, log: (message: string) => void): void {
	for (const unit of state.units) {
		if (!isDone(unit) || !unit.contentHash) continue;
		// A damaged canonical copy is not spread to work/; reopenDamaged deals with the unit.
		const { content: canonical } = readCommitted({ paths, mode: state.mode }, unit);
		if (canonical === undefined) continue;
		const working = join(paths.workDir, unitFile(state.mode, unit));
		const current = existsSync(working) ? readFileSync(working, "utf8") : undefined;
		if (current === undefined || sha256Text(current) !== unit.contentHash) {
			writeFileAtomic(working, canonical);
			if (current !== undefined) {
				log(`${state.stem}: ${unitFile(state.mode, unit)} was changed after it was finished; restored`);
			}
		}
	}
}

/**
 * Finished units whose canonical copy in run/committed/ is missing or no longer matches its recorded hash are
 * reopened as pending, so that they are redone instead of being exported as finished. Returns one message per unit.
 */
function reopenDamaged(paths: DocPaths, state: DocState): string[] {
	const messages: string[] = [];
	for (const unit of state.units as UnitWithStops[]) {
		const { problem } = readCommitted({ paths, mode: state.mode }, unit);
		if (!problem) continue;
		messages.push(`${unit.id}: ${problem}; the unit was reopened and will be redone`);
		unit.status = "pending";
		unit.contentHash = undefined;
		unit.issues = undefined;
		unit.closedReason = undefined;
		unit.carryOver = undefined;
		unit.committedAt = undefined;
		unit.toolCalls = 0;
		unit.views = 0;
		unit.verifyRuns = 0;
		unit.stops = 0;
		unit.rejections = undefined;
		unit.softCapBlocks = undefined;
		unit.hardCapClosed = undefined;
		unit.session = undefined;
	}
	return messages;
}

/**
 * Point image units at the current files of the document. The source fingerprint compares only file names, sizes
 * and times, so a folder that was moved or renamed still matches; its units must not keep the old paths. The
 * distinct image files of the units, in unit order, are exactly the document's image list.
 */
function rebindImages(state: DocState, images: string[]): void {
	const previous = [...new Set(state.units.map((unit) => unit.image).filter((image) => image !== undefined))];
	if (previous.length === 0) return;
	const byName = new Map(images.map((image) => [basename(image), image]));
	const mapping = new Map<string, string>();
	previous.forEach((old, i) => {
		const current = previous.length === images.length ? images[i] : byName.get(basename(old));
		if (current) mapping.set(old, current);
	});
	for (const unit of state.units) {
		if (unit.image) unit.image = mapping.get(unit.image) ?? unit.image;
	}
}

/** The next lower image profile after a rejected image request, still within the user's --max-image-px cap. */
export function fallbackProfile(profile: ImageProfile, maxImagePx: number | undefined): ImageProfile | undefined {
	const downgraded = downgradeProfile(profile);
	return downgraded ? withMaxEdge(downgraded, maxImagePx) : undefined;
}

/** Replace base64 image data in a saved pi session log; the images are large and reproducible from the source. */
function stripSessionImages(path: string): void {
	if (!existsSync(path)) return;
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (value && typeof value === "object") {
			const object = value as Record<string, unknown>;
			if (object.type === "image" && typeof object.data === "string") {
				return { ...object, data: "", omitted: true };
			}
			return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, strip(child)]));
		}
		return value;
	};
	const lines = readFileSync(path, "utf8").split("\n");
	const result = lines.map((line) => {
		if (!line.trim() || !line.includes('"image"')) return line;
		try {
			return JSON.stringify(strip(JSON.parse(line)));
		} catch {
			return line;
		}
	});
	writeFileAtomic(path, result.join("\n"));
}

/** Flatten unit content into prompt text plus images, keeping the reading order explicit. */
function toPrompt(content: MessageContent): { text: string; images: ImageContent[] } {
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of content) {
		if (block.type === "text") {
			texts.push(block.text);
		} else {
			images.push(block);
			texts.push(`[image ${images.length} attached below]`);
		}
	}
	return { text: texts.join("\n\n"), images };
}

async function prepareContextImages(
	paths: string[],
	profile: ImageProfile,
): Promise<Array<{ label: string; image: PreparedImage }>> {
	const images: Array<{ label: string; image: PreparedImage }> = [];
	for (const path of paths) images.push({ label: basename(path), image: await prepareContextImage(path, profile) });
	return images;
}

interface DocumentContext {
	doc: SourceDocument;
	options: RunOptions;
	schema: LoadedSchema;
	paths: DocPaths;
	state: DocState;
	sources: UnitSources;
	context: ContextBundle;
	modelRuntime: ModelRuntime;
	model: Model<any> | undefined;
	agentDir: string;
	/** Image profiles per model for this document (so a fallback sticks for its later sessions). */
	profiles: Map<string, ImageProfile>;
	/** Run-wide notices already logged (each is logged once per run). */
	notices: Set<string>;
	/** Consecutive units closed for review in this run of the document; sessions end as soon as the limit is hit. */
	reviewStreak: { count: number; limit: number };
	persist: () => void;
}

/**
 * The shell for pi's bash tool. pi (utils/shell getShellConfig) uses the shellPath setting, else on Windows Git
 * Bash under Program Files or bash.exe on PATH; elsewhere it always finds a shell. Per-user Git installs
 * (%LOCALAPPDATA%\Programs\Git) are tried as well and returned as `path`, to be passed to pi as shellPath.
 */
export function findBashShell(
	configured: string | undefined,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
	onPath: () => boolean = bashOnPath,
): { available: boolean; path?: string } {
	if (configured) return { available: exists(configured) };
	if (platform !== "win32") return { available: true };
	const known = [env.ProgramFiles, env["ProgramFiles(x86)"]]
		.filter((dir): dir is string => !!dir)
		.map((dir) => `${dir}\\Git\\bin\\bash.exe`);
	if (known.some(exists)) return { available: true };
	if (onPath()) return { available: true };
	const local = env.LOCALAPPDATA;
	const perUser = local
		? [`${local}\\Programs\\Git\\bin\\bash.exe`, `${local}\\Programs\\Git\\usr\\bin\\bash.exe`]
		: [];
	const found = perUser.find(exists);
	return found ? { available: true, path: found } : { available: false };
}

/** Prefix for the agent's bash commands: UTF-8 for Python's files and streams, and a UTF-8 locale on Windows. */
export const UTF8_SHELL_PREFIX =
	process.platform === "win32"
		? "export PYTHONUTF8=1 PYTHONIOENCODING=utf-8 LC_ALL=C.UTF-8"
		: "export PYTHONUTF8=1 PYTHONIOENCODING=utf-8";

let bashOnPathCache: boolean | undefined;

function bashOnPath(): boolean {
	if (bashOnPathCache !== undefined) return bashOnPathCache;
	try {
		const result = spawnSync("where", ["bash.exe"], { encoding: "utf8", timeout: 5000, windowsHide: true });
		const first = result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
		bashOnPathCache = !!first && existsSync(first);
	} catch {
		bashOnPathCache = false;
	}
	return bashOnPathCache;
}

const PYTHON_PROBE = "import json, sys, numpy, PIL; print(json.dumps([sys.executable, sys.prefix, sys.base_prefix]))";

/**
 * Stops the run (exit code 2) unless the python tool's interpreter starts and imports numpy and Pillow. Returns the
 * interpreter's absolute path and the folders it reads from (sys.prefix and sys.base_prefix).
 */
async function checkPython(
	config: ChronoConfig,
	runner: PythonRunner,
): Promise<{ executable: string; dirs: string[] }> {
	const fail = (detail: string) =>
		new Error(
			`The python tool was requested (--python or in --tools), but ${detail}. Set python_path (--python-path) to an interpreter with numpy and Pillow, or leave python out.`,
		);
	let run: Awaited<ReturnType<PythonRunner>>;
	try {
		run = await runner({
			python: config.pythonPath,
			args: ["-c", PYTHON_PROBE],
			cwd: tmpdir(),
			env: pythonEnvironment(tmpdir(), { current: "" }),
			timeoutMs: 60_000,
		});
	} catch (error) {
		throw fail(`${config.pythonPath} could not be started (${errorMessage(error)})`);
	}
	const line = run.stdout.trim().split(/\r?\n/).pop() ?? "";
	let paths: unknown;
	try {
		paths = JSON.parse(line);
	} catch {
		paths = undefined;
	}
	if (run.exitCode !== 0 || !Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
		throw fail(
			`${config.pythonPath} cannot import numpy and Pillow (${(run.stderr || run.stdout).trim().slice(-300)})`,
		);
	}
	const [executable, ...dirs] = paths as string[];
	return { executable, dirs: [...new Set(dirs)] };
}

/**
 * The interpreter and runner of the python tool for this run. By default the interpreter runs in the sandbox, which
 * is probed first; without one the run stops (exit code 2) unless python_sandbox is false. Tests inject a runner.
 */
async function preparePython(
	config: ChronoConfig,
	injected: PythonRunner | undefined,
	log: (message: string) => void,
): Promise<{ python: string; runner: PythonRunner }> {
	if (injected) {
		await checkPython(config, injected);
		return { python: config.pythonPath, runner: injected };
	}
	const { executable, dirs } = await checkPython(config, localPythonRunner);
	if (!config.pythonSandbox) {
		log(`python: ${executable}, not sandboxed (python_sandbox: false); scripts run with your user's permissions`);
		return { python: executable, runner: localPythonRunner };
	}
	try {
		await checkSandbox(executable, dirs);
	} catch (error) {
		const setup =
			process.platform === "win32"
				? "On Windows, set the sandbox up once with `npx @anthropic-ai/sandbox-runtime@0.0.79 windows-install` (one UAC prompt)"
				: "See the sandbox requirements in the README (bubblewrap and socat on Linux)";
		throw new Error(
			`The python tool runs in a sandbox, which is not available: ${errorMessage(error)}. ${setup}, or pass --no-python-sandbox to run scripts unsandboxed with your user's permissions.`,
		);
	}
	log(`python: ${executable}, sandboxed (no network; writes only to scratch/)`);
	return { python: executable, runner: sandboxedPythonRunner(dirs) };
}

interface SessionOutcome {
	finished: FinishedUnit[];
	error?: string;
	/** The session ended because of a provider or transport error (not because of the agent's work). */
	providerError?: boolean;
	/** The provider rejected the image parameters; the profile was downgraded and the batch should be retried. */
	imageFallback?: boolean;
	aborted?: boolean;
}

type UnitWithStops = UnitRecord & { stops?: number };

async function runSession(ctx: DocumentContext, batch: UnitRecord[]): Promise<SessionOutcome> {
	const { options, state, paths, schema } = ctx;
	const { config, log, signal } = options;
	if (signal?.aborted) return { finished: [], aborted: true };
	refreshSources(ctx);
	const inputKind = state.inputKind;
	const settingsManager = options.services?.settings
		? SettingsManager.inMemory(options.services.settings)
		: SettingsManager.create(paths.workDir, ctx.agentDir);
	// Mabillon sizes every image for the model itself, so pi must not shrink them to its 2,000 px default.
	settingsManager.applyOverrides({ compaction: { enabled: true }, images: { autoResize: false } });
	// Flex requests can wait for capacity; pi's request timeout (its 5-minute HTTP idle timeout unless
	// retry.provider.timeoutMs is set) is raised to the 15 minutes OpenAI suggests.
	if (config.serviceTier === "flex" && (settingsManager.getProviderRetrySettings().timeoutMs ?? 0) < FLEX_TIMEOUT_MS) {
		settingsManager.applyOverrides({ retry: { provider: { timeoutMs: FLEX_TIMEOUT_MS } } });
	}
	let entries = false;
	if (options.mode === "extract") {
		const { setup, error } = resolveAddEntries(schema);
		entries = setup !== undefined;
		if (error && !ctx.notices.has("no-add-entries")) {
			ctx.notices.add("no-add-entries");
			log(`schema ${schema.name}: running without the add_entries and update_entry tools (${error})`);
		}
	}
	const tools = new Set<ToolName>(effectiveTools(config, { mode: options.mode, inputKind, entries }));
	if (tools.has("bash")) {
		// The run checked at its start that a shell exists (see checkBashAvailable).
		const shell = (options.services?.findShell ?? findBashShell)(settingsManager.getShellPath());
		if (!shell.available) throw new Error(NO_SHELL_MESSAGE);
		if (shell.path) settingsManager.applyOverrides({ shellPath: shell.path });
		// Scripts the agent runs must write UTF-8: Python on Windows defaults to the ANSI code page (cp1252), which
		// corrupted committed units. pi offers no bash environment setting, but runs its command prefix before every
		// command; the user's own prefix follows.
		const own = settingsManager.getShellCommandPrefix();
		settingsManager.applyOverrides({ shellCommandPrefix: [UTF8_SHELL_PREFIX, own].filter(Boolean).join("\n") });
	}
	const toolList = TOOL_NAMES.filter((name) => tools.has(name));
	// The effective tool set is part of the run's record (ablations compare tool sets).
	state.tools = toolList;
	const runtime: SessionRuntime = {
		paths,
		workDir: paths.workDir,
		mode: options.mode,
		inputKind,
		schema,
		config,
		state,
		batch,
		tools,
		documentLabel: documentLabel(ctx.doc),
		contextImages: [],
		imageProfile: resolveImageProfile(undefined, "standard"),
		sources: ctx.sources,
		pythonRunner: options.services?.pythonRunner,
		reviewStreak: ctx.reviewStreak,
		persist: ctx.persist,
		log,
	};
	const handle = createChronoExtension(runtime);
	const systemPrompt = buildSystemPrompt({
		mode: options.mode,
		inputKind,
		schema,
		config,
		tools,
		context: ctx.context,
		documentLabel: runtime.documentLabel,
		totalUnits: state.units.length,
	});
	const loader = new DefaultResourceLoader({
		cwd: paths.workDir,
		agentDir: ctx.agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
		extensionFactories: [{ name: "mabillon", factory: handle.factory }],
	});
	await loader.reload();
	const sessionManager = SessionManager.create(paths.workDir, paths.sessionsDir);
	const { session } = await createAgentSession({
		cwd: paths.workDir,
		agentDir: ctx.agentDir,
		modelRuntime: ctx.modelRuntime,
		model: ctx.model,
		thinkingLevel: config.thinking,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
		tools: toolList,
	});
	await session.bindExtensions({
		onError: (failure) => log(`${state.stem}: extension error in ${failure.event}: ${failure.error}`),
	});
	if (!session.model) {
		session.dispose();
		throw new FatalRunError(
			"No model available. Pass --model provider/id and make sure you are logged in (run `mabillon tui` and use /login) or have an API key set.",
		);
	}
	runtime.reserveTokens = settingsManager.getCompactionSettings(session.model).reserveTokens;
	const modelKey = `${session.model.provider}/${session.model.id}`;
	const routing = openRouterPreferences(config, session.model);
	const sentRouting = effectiveRouting(session.model, routing);
	// The run checked at its start that a model with a service tier is an OpenAI model used with an API key.
	const serviceTier = isOpenAIResponses(session.model) ? config.serviceTier : undefined;
	// The routing and the service tier travel with the model, so requests that bypass before_provider_request
	// (pi's compaction summaries) carry them too.
	session.agent.state.model = withServiceTier(withOpenRouterRouting(session.model, routing), serviceTier);
	let profile = ctx.profiles.get(modelKey);
	if (!profile) {
		profile = withMaxEdge(resolveImageProfile(session.model, config.imageQuality), config.maxImagePx);
		ctx.profiles.set(modelKey, profile);
		if (inputKind === "images" || ctx.context.images.length > 0) log(`images for ${modelKey}: ${profile.label}`);
		if (routing) log(`routing for ${modelKey}: ${describePreferences(routing)}`);
	}
	runtime.imageProfile = profile;
	runtime.routing = routing;
	runtime.serviceTier = serviceTier;
	runtime.servedBy = new Set();
	runtime.contextImages = await prepareContextImages(ctx.context.images, profile);

	const record: SessionRecord = {
		startedAt: new Date().toISOString(),
		units: batch.map((unit) => unit.id),
		model: modelKey,
		thinking: session.thinkingLevel,
		tools: toolList,
		imageProfile: profile.label,
		...(sentRouting && Object.keys(sentRouting).length > 0 ? { routing: sentRouting } : {}),
		...(runtime.serviceTier ? { serviceTier: runtime.serviceTier } : {}),
	};
	state.sessions.push(record);
	ctx.persist();
	log(
		`${state.stem}: session ${state.sessions.length} with ${modelKey}${record.thinking ? ` (${record.thinking})` : ""}${record.serviceTier ? `, service tier ${record.serviceTier}` : ""}: ${batch[0].id}-${batch[batch.length - 1].id}`,
	);

	const unsubscribe = session.subscribe((event) => {
		if (!config.verbose) return;
		if (event.type === "tool_execution_start") {
			const args = JSON.stringify(event.args ?? {});
			log(`  ${event.toolName} ${args.length > 160 ? `${args.slice(0, 160)}…` : args}`);
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const text = event.message.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join(" ")
				.trim();
			if (text) log(`  » ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`);
		}
	});
	const onAbort = () => {
		void session.abort();
	};
	signal?.addEventListener("abort", onAbort);
	let error: string | undefined;
	let providerError = false;
	try {
		if (!signal?.aborted) {
			const { unit, content } = await handle.firstDelivery(sessionIntro(runtime));
			if (unit && !signal?.aborted) {
				const { text, images } = toPrompt(content);
				await session.prompt(text, { images, expandPromptTemplates: false });
				const lastMessage = session.messages[session.messages.length - 1] as
					| { role?: string; stopReason?: string; errorMessage?: string }
					| undefined;
				if (lastMessage?.role === "assistant" && lastMessage.stopReason === "error" && !handle.stoppedByHarness()) {
					error = lastMessage.errorMessage ?? "model request failed";
					providerError = true;
				}
			}
		}
	} catch (caught) {
		if (!handle.stoppedByHarness()) {
			error = errorMessage(caught);
			providerError = true;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		const stats = session.getSessionStats();
		record.file = stats.sessionFile ? relative(paths.docDir, stats.sessionFile) : undefined;
		record.endedAt = new Date().toISOString();
		record.inputTokens = stats.tokens.input;
		record.outputTokens = stats.tokens.output;
		record.cacheReadTokens = stats.tokens.cacheRead;
		record.cost = stats.cost;
		record.compactions = handle.compactions();
		if (runtime.servedBy?.size) record.servedBy = [...runtime.servedBy].sort();
		if (error) record.error = error;
		ctx.persist();
		session.dispose();
		if (stats.sessionFile && !config.keepSessionImages) {
			try {
				stripSessionImages(stats.sessionFile);
			} catch {
				// the log stays as written
			}
		}
	}
	const finished = handle.finished();
	if (signal?.aborted) return { finished, aborted: true };
	if (error && providerError) {
		if (isImageRequestError(error)) {
			if (!config.imageFallback) {
				throw new Error(
					`the provider rejected the image request (${error}); image fallback is off (--no-image-fallback)`,
				);
			}
			const fallback = fallbackProfile(profile, config.maxImagePx);
			if (fallback) {
				log(`${state.stem}: the provider rejected the image request (${error}); retrying with ${fallback.label}`);
				ctx.profiles.set(modelKey, fallback);
				// Recorded: the units after this point were seen at a lower image fidelity.
				state.imageFallbacks = [
					...(state.imageFallbacks ?? []),
					{ session: state.sessions.length, model: modelKey, from: profile.label, to: fallback.label },
				];
				ctx.persist();
				return { finished, error, providerError, imageFallback: true };
			}
		}
		return { finished, error, providerError };
	}
	const unit = handle.current() as UnitWithStops | undefined;
	if (unit && !handle.isDone()) {
		// The agent stopped without committing despite reminders. A fresh session gets one more try at the unit;
		// a second stop closes it for review so the document can move on.
		unit.stops = (unit.stops ?? 0) + 1;
		if (unit.stops >= 2) handle.closeCurrent("the agent stopped twice without committing");
		ctx.persist();
	}
	return { finished: handle.finished(), error };
}

function checkCompatible(existing: DocState, mode: Mode, schema: LoadedSchema, inputKind: InputKind) {
	const problems: string[] = [];
	if (existing.mode !== mode) problems.push(`it was started in ${existing.mode} mode`);
	if (existing.inputKind !== inputKind) problems.push(`it used ${existing.inputKind} input`);
	if (existing.schema.name !== schema.name) problems.push(`it used schema ${existing.schema.name}`);
	else if (existing.schema.sha256 !== schema.sha256 && existing.schema.sha256 !== schema.legacySha256) {
		problems.push("the schema file has changed since");
	}
	if (problems.length > 0) {
		throw new Error(`Existing work cannot be resumed: ${problems.join("; ")}. Use --force to start over.`);
	}
}

/** The system prompt the document's sessions start with (recorded by hash, and stored as the run's prompt). */
function systemPromptFor(
	doc: SourceDocument,
	options: RunOptions,
	schema: LoadedSchema,
	inputKind: InputKind,
	context: ContextBundle,
	totalUnits: number,
): string {
	const { config, mode } = options;
	const entries = mode === "extract" && resolveAddEntries(schema).setup !== undefined;
	const tools = effectiveTools(config, { mode, inputKind, entries });
	return buildSystemPrompt({
		mode,
		inputKind,
		schema,
		config,
		tools: new Set(tools),
		context,
		documentLabel: documentLabel(doc),
		totalUnits,
	});
}

/** The experiment arm of a document: everything apart from the model that shapes the agent's work. */
function experimentRecord(
	doc: SourceDocument,
	options: RunOptions,
	schema: LoadedSchema,
	inputKind: InputKind,
	context: ContextBundle,
	totalUnits: number,
): ExperimentRecord {
	const { config, mode } = options;
	const entries = mode === "extract" && resolveAddEntries(schema).setup !== undefined;
	const tools = effectiveTools(config, { mode, inputKind, entries });
	checkToolSet(tools, { mode, inputKind });
	const settings: Record<string, unknown> = {
		unitsPerSession: config.unitsPerSession,
		compactAtTokens: config.compactAtTokens,
		toolSoftCap: config.toolSoftCap,
		toolHardCap: config.toolHardCap,
		settleRetries: config.settleRetries,
		groundingThreshold: config.groundingThreshold,
		imageQuality: config.imageQuality,
		maxImagePx: config.maxImagePx ?? null,
		imageFallback: config.imageFallback,
		// Correction mode is a different arm; the drafts themselves are recorded per unit.
		...(config.drafts !== undefined ? { correction: true } : {}),
		...(doc.kind === "pdf" ? { dpi: config.dpi, maxRenderPixels: config.maxRenderPixels } : {}),
		...(inputKind === "text"
			? { chunkTokens: config.chunkTokens, allowPartialRanges: config.allowPartialRanges }
			: {}),
		// The helper module the agent starts from is part of the arm; the interpreter is not (recorded per session).
		...(tools.includes("python")
			? {
					pythonTimeout: config.pythonTimeout,
					pythonSandbox: config.pythonSandbox,
					pythonHelperSha256: bundledHelperSha256(),
				}
			: {}),
	};
	const systemPrompt = systemPromptFor(doc, options, schema, inputKind, context, totalUnits);
	return {
		tools,
		...(mode === "extract" ? { boundary: boundaryPolicy(schema) } : {}),
		settings,
		context: {
			texts: context.texts.map((text) => ({ file: text.path, sha256: sha256Text(text.content) })),
			images: context.images.map((path) => ({ file: path, sha256: sha256File(path) })),
		},
		systemPromptSha256: sha256Text(systemPrompt),
	};
}

/** A resume must run the same experiment arm (model and thinking may change; each unit records its session). */
/** Whether the agent has already worked on a document: sessions, finished units, drafts, or notes. */
function hasAgentWork(existing: DocState, paths: DocPaths): boolean {
	if (existing.sessions.length > 0 || existing.units.some(isDone)) return true;
	const unitsDir = join(paths.workDir, "units");
	if (existsSync(unitsDir) && readdirSync(unitsDir).length > 0) return true;
	const notes = join(paths.workDir, "notes.md");
	return existsSync(notes) && readFileSync(notes, "utf8").trim() !== "";
}

function checkExperiment(existing: DocState, current: ExperimentRecord, paths: DocPaths) {
	const recorded = existing.experiment;
	if (!recorded) {
		// A run from before experiment records: whatever the agent did there was done under unknown settings, which
		// must not be relabelled with the current ones. Only a run the agent never worked on can adopt them.
		if (hasAgentWork(existing, paths)) {
			throw new Error(
				"Existing work cannot be resumed: the run predates experiment records, so the settings of its earlier work are unknown. Use --force or a fresh output folder.",
			);
		}
		return;
	}
	const problems: string[] = [];
	if (recorded.tools.join(",") !== current.tools.join(",")) {
		problems.push(`it used the tools ${recorded.tools.join(", ")} (now ${current.tools.join(", ")})`);
	}
	if (recorded.boundary !== current.boundary) problems.push(`it used the boundary policy ${recorded.boundary}`);
	const keys = new Set([...Object.keys(recorded.settings), ...Object.keys(current.settings)]);
	for (const key of keys) {
		if (JSON.stringify(recorded.settings[key]) !== JSON.stringify(current.settings[key])) {
			problems.push(
				`${key} was ${JSON.stringify(recorded.settings[key])} (now ${JSON.stringify(current.settings[key])})`,
			);
		}
	}
	const files = (context: ExperimentRecord["context"]) =>
		JSON.stringify([...context.texts, ...context.images].map((item) => [basename(item.file), item.sha256]));
	if (files(recorded.context) !== files(current.context)) problems.push("the context files differ");
	if (problems.length === 0 && recorded.systemPromptSha256 !== current.systemPromptSha256) {
		problems.push("the system prompt differs (a different Mabillon version or prompt input)");
	}
	if (problems.length > 0) {
		throw new Error(`Existing work cannot be resumed: ${problems.join("; ")}. Use --force to start over.`);
	}
}

function checkFingerprint(existing: DocState, fingerprint: SourceFingerprint) {
	const recorded = existing.fingerprint;
	if (recorded.source !== fingerprint.source) {
		throw new Error(
			`This output folder belongs to ${existing.source}, and the source differs from the one this run was started with. Use --force to start over, or --out for a separate folder.`,
		);
	}
	if (recorded.chunkTokens !== undefined && recorded.chunkTokens !== fingerprint.chunkTokens) {
		throw new Error(
			`The run was chunked with chunk_tokens ${recorded.chunkTokens}; resuming with ${fingerprint.chunkTokens} would change the units. Use the original value or --force.`,
		);
	}
	if (recorded.lineRanges !== fingerprint.lineRanges) {
		throw new Error("The ChronoMiner line-ranges file changed since the run started. Use --force to start over.");
	}
}

async function processDocument(
	doc: SourceDocument,
	options: RunOptions,
	schema: LoadedSchema,
	modelRuntime: ModelRuntime,
	model: Model<any> | undefined,
	agentDir: string,
	notices: Set<string>,
	plan: ChronoPlan,
	registry: StoreRegistry,
	draftsSource: DraftsStore | undefined,
): Promise<DocumentResult> {
	const { config, log, mode } = options;
	const paths = docPaths(plan.workingDir);
	const result: DocumentResult = {
		stem: doc.stem,
		source: doc.path,
		outputDir: plan.outputDir,
		workingDir: paths.docDir,
		units: 0,
		selected: 0,
		committed: 0,
		needsReview: 0,
		reviewUnits: [],
		pending: 0,
		cost: 0,
	};
	const selected = parseSelection(config.units);
	/** Problems noticed during this run (reported with the result, not stored in the state). */
	const runWarnings: string[] = [];
	const runWarning = (message: string) => {
		runWarnings.push(message);
		log(`${doc.stem}: ${message}`);
	};
	let release: (() => void) | undefined;
	let pdf: PdfSource | undefined;
	let state: DocState | undefined;
	const sync = new ChronoSync(plan, registry, {
		mode,
		schema,
		force: config.force,
		model: model ? { provider: model.provider, model: model.id } : { provider: "unknown", model: "unknown" },
		units: config.units,
		log,
		warn: runWarning,
	});
	try {
		if (doc.refusal) throw new Error(doc.refusal);
		const legacy = existsSync(join(paths.runDir, "state.json")) ? undefined : legacyRunFolder(doc, config);
		if (legacy) {
			throw new Error(
				`${legacy} holds a run of Mabillon before 0.10.0, which this version neither resumes nor converts; finish it with that version, or move the folder away to start the document afresh here`,
			);
		}
		ensureDir(paths.runDir);
		release = acquireLock(paths.runDir);
		// Leases, open batches, input identity and schema of the store documents are checked before anything is
		// deleted or changed; --force deletes the local work only after that.
		sync.preflight();
		if (config.force) {
			const previous = loadStateQuietly(paths.runDir);
			if (previous && previous.mode !== mode) {
				throw new Error(
					`${paths.docDir} holds a ${previous.mode === "transcribe" ? "transcription" : "extraction"} run; --force does not replace it with this ${mode === "transcribe" ? "transcription" : "extraction"}`,
				);
			}
			if (previous && canonicalPath(previous.source) !== canonicalPath(doc.path)) {
				throw new Error(
					`${paths.docDir} holds the run of ${previous.source}; --force does not replace it with ${doc.path}. Set --out (and --layout) to keep the two apart`,
				);
			}
			rmSync(paths.workDir, { recursive: true, force: true });
			for (const name of ["state.json", "text", "committed", "sessions"]) {
				rmSync(join(paths.runDir, name), { recursive: true, force: true });
			}
		}
		for (const dir of [join(paths.workDir, "units"), join(paths.workDir, "scratch"), paths.sessionsDir]) {
			ensureDir(dir);
		}
		const inputKind: InputKind = doc.kind === "text" ? "text" : "images";
		if (doc.kind === "pdf") pdf = await PdfSource.open(doc.path);
		const fingerprint = sourceFingerprint(doc, config);
		const existing = loadState(paths.runDir);
		const context = resolveContext(doc, config, mode);
		let experiment: ExperimentRecord;
		// The state is prepared here and becomes the document's state (exported at the end) only once the store
		// accepted the document: a refused document changes neither its state nor its outputs.
		let prepared: DocState;
		/** Correction mode: the unit files to seed (new runs only). */
		let seeded: Array<{ unit: UnitRecord; content: string }> = [];
		if (existing) {
			// Every compatibility check comes before any change to the state: a refused resume leaves the state and
			// the outputs as they were (state stays undefined, so nothing is saved or exported).
			checkCompatible(existing, mode, schema, inputKind);
			checkFingerprint(existing, fingerprint);
			if (doc.kind === "text") await checkStoredText(doc, config, paths, existing);
			// The experiment arm (tools, settings, context, prompt) must be the same for all units of a run.
			experiment = experimentRecord(doc, options, schema, inputKind, context, existing.units.length);
			checkExperiment(existing, experiment, paths);
			// Runs of earlier versions recorded the digest of the schema text alone; store the current digest.
			existing.schema.sha256 = schema.sha256;
			prepared = existing;
			prepared.source = doc.path;
			if (doc.kind === "images") rebindImages(prepared, doc.images ?? []);
			for (const message of reopenDamaged(paths, prepared)) runWarning(message);
			if (config.redoReview) {
				for (const unit of prepared.units as UnitWithStops[]) {
					// Only units in the selection are re-run; resetting others would drop their drafts from the outputs.
					if (unit.status === "needs_review" && selected(unit.index)) {
						unit.status = "pending";
						unit.toolCalls = 0;
						unit.views = 0;
						unit.verifyRuns = 0;
						unit.stops = 0;
						unit.rejections = undefined;
						unit.softCapBlocks = undefined;
						unit.hardCapClosed = undefined;
						unit.session = undefined;
					}
				}
			}
		} else {
			const warnings: string[] = [];
			const warn = (message: string) => {
				warnings.push(message);
				log(`${doc.stem}: ${message}`);
			};
			// Correction mode: the drafts are read before the units are built, since a ChronoMiner text document's
			// chunk ranges become the units.
			const drafts = draftsSource
				? findDrafts(
						draftsSource,
						plan.tool === "chronominer"
							? plan.documents.map((document) => document.image ?? realPath(doc.path))
							: [realPath(doc.path)],
						{ select: config.draftsDocument, warn },
					)
				: undefined;
			const built = await buildUnits(doc, paths, config, pdf, fingerprint, warn, log, drafts?.[0].ranges);
			if (built.units.length === 0) {
				throw new Error(
					doc.kind === "text"
						? "no text found in the document (empty, or a structure the converter does not understand)"
						: "the document has no pages",
				);
			}
			const now = new Date().toISOString();
			prepared = {
				version: 2,
				mabillonVersion: readPackageVersion(),
				mode,
				inputKind,
				source: doc.path,
				stem: doc.stem,
				fingerprint,
				schema: { name: schema.name, sha256: schema.sha256, path: schema.path },
				units: built.units,
				totalLines: built.totalLines,
				uncoveredLines: built.uncovered,
				warnings: warnings.length > 0 ? warnings : undefined,
				sessions: [],
				createdAt: now,
				updatedAt: now,
			};
			experiment = experimentRecord(doc, options, schema, inputKind, context, built.units.length);
			if (drafts) {
				seeded = seedDrafts(drafts, prepared, schema, warn);
				prepared.drafts = {
					store: drafts[0].database,
					document: drafts.map((found) => found.document).join(", "),
					...(drafts[0].ranges ? { ranges: true } : {}),
				};
				log(
					`${doc.stem}: ${seeded.length} of ${prepared.units.length} unit(s) start from drafts of ${drafts[0].database}`,
				);
			}
			// Warnings of the seeding (drafts that cannot be read) come after the state was made.
			prepared.warnings = warnings.length > 0 ? warnings : undefined;
		}
		// The store documents: input identity, open batches, leases and chunk layout are checked, every unit is
		// planned, and units another tool finished are adopted, before any agent work.
		sync.start(prepared, paths, {
			prompt: systemPromptFor(doc, options, schema, inputKind, context, prepared.units.length),
			context: context.texts.map((text) => text.content),
		});
		// The seeded unit files are written only once the store accepted the document, with an immutable copy of
		// each draft in run/drafts/ (the agent changes the one in work/).
		for (const { unit, content } of seeded) {
			const file = unitFile(mode, unit);
			writeFileAtomic(join(paths.workDir, file), content);
			ensureDir(dirname(join(paths.runDir, "drafts", file)));
			writeFileAtomic(join(paths.runDir, "drafts", file), content);
		}
		state = prepared;
		const docState = prepared;
		docState.experiment = experiment;
		const persist = () => saveState(paths.runDir, docState);
		persist();
		if (!docState.units.some((unit) => selected(unit.index))) {
			throw new Error(`--units ${config.units} selects none of the document's ${docState.units.length} units`);
		}
		restoreCommitted(paths, docState, log);
		const notesPath = join(paths.workDir, "notes.md");
		if (!existsSync(notesPath)) writeFileSync(notesPath, "");

		if (context.texts.length > 0 || context.images.length > 0) {
			log(
				`${doc.stem}: context ${[...context.texts.map((text) => basename(text.path)), ...context.images.map((path) => basename(path))].join(", ")}`,
			);
		}
		const ctx: DocumentContext = {
			doc,
			options,
			schema,
			paths,
			state: docState,
			sources: createSources(paths, docState, config, pdf),
			context,
			modelRuntime,
			model,
			agentDir,
			// Per document: a fallback after a rejected image request does not carry over to other documents.
			profiles: new Map<string, ImageProfile>(),
			notices,
			reviewStreak: { count: 0, limit: REVIEW_STREAK_LIMIT },
			persist,
		};

		const retryDelays = options.services?.retryDelays ?? retryDelaysFor(config.serviceTier, DEFAULT_RETRY_DELAYS);
		let stalled = 0;
		let transientFailures = 0;
		let reviewStreak = 0;
		while (!options.signal?.aborted) {
			const pending = docState.units.filter((unit) => selected(unit.index) && !isDone(unit));
			if (pending.length === 0) break;
			const outcome = await runSession(ctx, pending.slice(0, config.unitsPerSession));
			restoreCommitted(paths, docState, log);
			if (outcome.aborted) break;
			for (const finished of outcome.finished) {
				reviewStreak = finished.status === "committed" ? 0 : reviewStreak + 1;
				if (reviewStreak >= REVIEW_STREAK_LIMIT) {
					throw new Error(
						`${reviewStreak} consecutive units were closed for review (last: ${finished.id}, ${finished.reason}). Stopping this document; check the model, schema and context, then rerun with --redo-review.`,
					);
				}
			}
			// Sessions that make progress start the transient-error budget afresh.
			if (outcome.finished.length > 0) transientFailures = 0;
			if (outcome.providerError && outcome.error) {
				if (outcome.imageFallback) continue;
				const kind = classifyProviderError(outcome.error);
				if (kind === "auth") throw new FatalRunError(`provider rejected the credentials: ${outcome.error}`);
				if (kind === "quota") throw new FatalRunError(`provider quota or usage limit reached: ${outcome.error}`);
				if (kind === "routing") {
					throw new FatalRunError(
						`OpenRouter found no endpoint that meets the routing settings (${outcome.error}). With zdr on (the default) only zero-data-retention endpoints are used: choose another model, change openrouter_providers or openrouter_quantizations, or pass --no-zdr if data retention is acceptable for these sources.`,
					);
				}
				if (kind === "transient" && transientFailures < retryDelays.length) {
					const delay = retryDelays[transientFailures++];
					log(`${doc.stem}: provider error (${outcome.error}); retrying in ${Math.round(delay / 1000)} s`);
					await sleep(delay, options.signal);
					continue;
				}
				throw new Error(`provider error: ${outcome.error}`);
			}
			transientFailures = 0;
			if (outcome.finished.length === 0) {
				stalled++;
				if (stalled >= MAX_STALLED_SESSIONS) {
					throw new Error(
						`${MAX_STALLED_SESSIONS} consecutive sessions finished no unit${outcome.error ? ` (${outcome.error})` : ""}`,
					);
				}
			} else {
				stalled = 0;
			}
		}
	} catch (error) {
		result.error = errorMessage(error);
		if (error instanceof FatalRunError) result.fatal = true;
	} finally {
		try {
			if (state) {
				// Committed copies changed during the run (e.g. through bash) are not exported as finished.
				const damaged = reopenDamaged(paths, state);
				for (const message of damaged) runWarning(message);
				const database = sync.databasePath();
				const store: StoreRecord | undefined = database ? { database, documents: sync.documentNames() } : undefined;
				const { finalValidation, ...outputs } = writeOutputs(paths, state, schema, selected, plan.sidecar, store);
				if (finalValidation) {
					result.finalValidation = finalValidation;
					log(
						`${doc.stem}: the merged output does not validate against the schema: ${finalValidation.join("; ")}`,
					);
				}
				// The store rows and the rendered files (a transcription without a store row renders from its units).
				const exported = sync.export(state, paths);
				let hashes: Record<string, string> | undefined;
				if (!database && plan.textOutputs) {
					const rendered = renderWithoutStore(
						plan,
						state,
						paths,
						schema,
						state.export?.hashes ?? {},
						config.force,
					);
					exported.files.push(...rendered.report.written, ...rendered.report.unchanged);
					exported.warnings.push(...rendered.report.warnings);
					hashes = rendered.hashes;
					exported.stale.push(...rendered.report.stale);
					exported.kept.push(...rendered.report.kept);
					if (exported.stale.length > 0 || exported.kept.length > 0) {
						exported.error ??= staleError(exported.stale, exported.kept);
					}
				}
				for (const message of exported.warnings) runWarning(message);
				if (exported.error) result.error ??= exported.error;
				const files = new Set(exported.files);
				for (const output of [
					...plan.documents.flatMap((document) => document.outputs),
					...(plan.textOutputs ?? []),
				]) {
					if (!files.has(output.path)) continue;
					const key = output.format as "txt" | "md" | "json" | "csv";
					// An image folder's extraction has one _output.json per image; the result names the folder of them.
					if (outputs[key] === undefined) outputs[key] = plan.documents.length > 1 ? plan.outputDir : output.path;
				}
				if (database) outputs.store = database;
				result.outputs = outputs;
				// Recorded for `status`, which reads only the state.
				state.export = {
					at: new Date().toISOString(),
					...(finalValidation ? { finalValidation } : {}),
					...(exported.error ? { error: exported.error } : {}),
					// Tie the export to the unit state it was made from and the files it wrote.
					unitsDigest: unitsDigest(state.units),
					files: [outputs.sidecar, ...exported.files].map((file) => relative(paths.docDir, file)),
					...(hashes ? { hashes } : {}),
				};
				saveState(paths.runDir, state);
			}
		} catch (error) {
			result.error ??= `could not write outputs: ${errorMessage(error)}`;
			if (state) {
				state.export = { at: new Date().toISOString(), error: errorMessage(error) };
				try {
					saveState(paths.runDir, state);
				} catch {
					// the result still reports the error
				}
			}
		}
		sync.release();
		release?.();
		await pdf?.close().catch(() => undefined);
		clearImageCache();
	}
	if (state) {
		const inSelection = state.units.filter((unit) => selected(unit.index));
		result.units = state.units.length;
		result.selected = inSelection.length;
		result.committed = inSelection.filter((unit) => unit.status === "committed").length;
		result.reviewUnits = inSelection
			.filter((unit) => unit.status === "needs_review")
			.map((unit) => ({ unit: unit.id, reason: unit.closedReason }));
		result.needsReview = result.reviewUnits.length;
		result.pending = inSelection.filter((unit) => !isDone(unit)).length;
		result.cost = state.sessions.reduce((sum, session) => sum + (session.cost ?? 0), 0);
		if (state.tools) result.tools = state.tools;
		const warnings = [...(state.warnings ?? []), ...runWarnings];
		if (warnings.length > 0) result.warnings = warnings;
	}
	return result;
}

/** Resolve the model once for the whole run (shared pi credentials and models.json). */
async function resolveModel(
	config: ChronoConfig,
	services: RunServices | undefined,
): Promise<{ modelRuntime: ModelRuntime; model: Model<any> | undefined; agentDir: string }> {
	const agentDir = services?.agentDir ?? getAgentDir();
	const modelRuntime = services?.modelRuntime ?? (await ModelRuntime.create());
	if (!config.model) return { modelRuntime, model: undefined, agentDir };
	const resolved = resolveCliModel({ cliModel: config.model, modelRuntime });
	if (resolved.error || !resolved.model) {
		throw new Error(
			(resolved.error ?? `Unknown model "${config.model}"`).replace(
				"Use --list-models",
				"Run `mabillon tui` and /model",
			),
		);
	}
	return { modelRuntime, model: resolved.model, agentDir };
}

function loadStateQuietly(runDir: string): DocState | undefined {
	try {
		return loadState(runDir);
	} catch {
		return undefined;
	}
}

/**
 * The folder of a run of Mabillon before 0.10.0 for this document, if one is there: `<--out>/<stem>/` or
 * `<input folder>/chronoagent_output/<stem>/` (named mabillon_output in that version's documentation).
 */
function legacyRunFolder(doc: SourceDocument, config: ChronoConfig): string | undefined {
	const roots = config.out
		? [config.out]
		: [join(dirname(doc.path), OUTPUT_DIR_NAME), join(dirname(doc.path), "mabillon_output")];
	return roots.map((root) => join(root, doc.stem)).find((folder) => existsSync(join(folder, "run", "state.json")));
}

/**
 * Refuse documents that would share an output and its store document, compared without case as the files are on
 * Windows and macOS (ChronoMiner and ChronoTranscriber refuse them the same way).
 */
function checkCollisions(documents: SourceDocument[], plans: ChronoPlan[]): void {
	// Every store document and every working folder, with the input that claims it (an image of a folder for a
	// ChronoMiner image document, so two images of one folder are compared too).
	const claimed = new Map<string, string>();
	const claim = (key: string, name: string, input: string, root: string) => {
		const first = claimed.get(key);
		if (first !== undefined && first !== input) {
			throw new Error(
				`${first} and ${input} would share the output ${name} in ${root} and its store document. Rename one of them, run them separately, or set --out (and --layout) to keep them apart.`,
			);
		}
		claimed.set(key, input);
	};
	plans.forEach((plan, index) => {
		const root = plan.root.toLowerCase();
		for (const document of plan.documents) {
			claim(
				`${plan.tool}\u0000${root}\u0000${document.name.toLowerCase()}`,
				document.name,
				document.image ?? documents[index].path,
				plan.root,
			);
		}
		claim(
			`${root}\u0000${MABILLON_DIR}\u0000${plan.name.toLowerCase()}`,
			plan.name,
			documents[index].path,
			plan.root,
		);
	});
}

/** The run's settings as the store's `runs.spec` records them: `{key: {value, source}}`. */
function runSpec(config: ChronoConfig): Record<string, { value: unknown; source: string }> {
	const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
	return Object.fromEntries(
		Object.entries(config as unknown as Record<string, unknown>)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [
				key,
				{ value, source: JSON.stringify(value) === JSON.stringify(defaults[key]) ? "default" : "settings" },
			]),
	);
}

export async function run(options: RunOptions): Promise<RunSummary> {
	const { config, log, mode } = options;
	// Configuration problems surface before any document is touched.
	parseSelection(config.units);
	checkContextFiles(config);
	const output = outputSettings(config, mode);
	const { documents, skipped } = discoverDocuments(options.inputs, mode, config.out ? [config.out] : []);
	for (const skip of skipped) log(`skipped ${skip.path}: ${skip.reason}`);
	if (documents.length === 0) return { documents: [], skipped };
	const outDir = config.out ? realPath(config.out) : undefined;
	const plans = documents.map((doc) => planDocument(doc, mode, { outDir, ...output }));
	// Stems stay unique per output folder for the logs and the legacy-run check.
	assignStems(documents, (doc) => plans[documents.indexOf(doc)].outputDir);
	checkCollisions(documents, plans);
	// A store Mabillon cannot write (another version, not a store) is refused before any document is touched.
	for (const key of new Set(plans.map((plan) => `${plan.tool}\u0000${plan.root}`))) {
		const [tool, root] = key.split("\u0000") as [ChronoPlan["tool"], string];
		ChronoStore.inspect(root, tool);
	}
	// Correction mode: the drafts store must be the mode's store, at the schema versions Mabillon reads.
	const draftsSource = config.drafts !== undefined ? resolveDrafts(config.drafts, mode) : undefined;
	// --force replaces the output store's units before the agent works; in place, those are the drafts.
	if (
		draftsSource &&
		config.force &&
		plans.some(
			(plan) => canonicalPath(join(plan.root, DATABASE_NAMES[plan.tool])) === canonicalPath(draftsSource.database),
		)
	) {
		throw new Error(
			`--force would reset the drafts of ${draftsSource.database}, which is also the output store, before the agent corrects them; drop the documents with ${draftsSource.tool} drop to start over, or write the correction to a separate --out`,
		);
	}
	const schema = resolveSchema(config.schema, mode, config.schemasDirs);
	if (mode === "extract" && !envelopeInfo(schema.schema).entriesField) {
		// Units are merged by concatenating their entries; without an entries array there is no defined merge.
		throw new Error(
			`Schema "${schema.name}" has no top-level "entries" array; extraction schemas need the envelope {"entries": [...]} (optionally with contains_no_content_of_requested_type and other top-level fields).`,
		);
	}
	// Tool sets the agent cannot work with are refused before any document is touched.
	const entries = mode === "extract" && resolveAddEntries(schema).setup !== undefined;
	for (const inputKind of new Set(documents.map((doc): InputKind => (doc.kind === "text" ? "text" : "images")))) {
		checkToolSet(effectiveTools(config, { mode, inputKind, entries }), { mode, inputKind });
	}
	log(`schema ${schema.name}${schema.bundled ? " (bundled)" : ""}; ${documents.length} document(s)`);
	const { modelRuntime, model, agentDir } = await resolveModel(config, options.services);
	// A service tier is refused for models it cannot reach, rather than silently not sent.
	if (config.serviceTier) {
		const auth = model ? await modelRuntime.checkAuth(model.provider) : undefined;
		checkServiceTierRoute(config.serviceTier, model, auth?.type);
	}
	// A requested bash must exist before any document is touched, so the recorded tool set is the one used.
	const bashWanted = [...new Set(documents.map((doc): InputKind => (doc.kind === "text" ? "text" : "images")))].some(
		(inputKind) => effectiveTools(config, { mode, inputKind, entries }).includes("bash"),
	);
	if (bashWanted) {
		const settings = options.services?.settings
			? SettingsManager.inMemory(options.services.settings)
			: SettingsManager.create(process.cwd(), agentDir);
		const shell = (options.services?.findShell ?? findBashShell)(settings.getShellPath());
		if (!shell.available) throw new Error(NO_SHELL_MESSAGE);
	}
	// Likewise a requested python: the interpreter must import numpy and Pillow, and the sandbox must hold.
	let runOptions = options;
	if (
		documents.some(
			(doc) =>
				doc.kind !== "text" && effectiveTools(config, { mode, inputKind: "images", entries }).includes("python"),
		)
	) {
		const { python, runner } = await preparePython(config, options.services?.pythonRunner, log);
		runOptions = {
			...options,
			config: { ...config, pythonPath: python },
			services: { ...options.services, pythonRunner: runner },
		};
	}
	const notices = new Set<string>();
	const registry = createRegistry({ command: mode, toolVersion: readPackageVersion(), spec: runSpec(config) });

	const results: DocumentResult[] = new Array(documents.length);
	let next = 0;
	let fatalError: string | undefined;
	const worker = async () => {
		while (next < documents.length && !options.signal?.aborted && !fatalError) {
			const index = next++;
			const doc = documents[index];
			log(`${doc.stem}: ${doc.path}`);
			const result = await processDocument(
				doc,
				runOptions,
				schema,
				modelRuntime,
				model,
				agentDir,
				notices,
				plans[index],
				registry,
				draftsSource,
			);
			results[index] = result;
			if (result.fatal) fatalError ??= result.error;
			if (result.error) log(`${doc.stem}: FAILED: ${result.error}`);
			else {
				const review = result.needsReview > 0 ? `, ${result.needsReview} need review` : "";
				log(
					`${doc.stem}: ${result.committed} of ${result.selected} committed${review}, ${result.pending} pending; cost $${result.cost.toFixed(4)}; outputs in ${result.outputDir}`,
				);
			}
		}
	};
	try {
		await Promise.all(Array.from({ length: Math.min(config.concurrency, documents.length) }, () => worker()));
	} finally {
		// The sandbox's grants and proxies end with the run.
		await resetSandbox();
		const finished = results.filter(Boolean);
		registry.closeAll(runExitCode(finished, options.signal?.aborted ?? false, fatalError !== undefined));
	}
	// Documents a fatal error or an interruption kept from starting are reported, not dropped.
	const notStarted = documents
		.filter((_, index) => results[index] === undefined)
		.map((doc) => ({
			path: doc.path,
			reason: fatalError
				? `not started: the run stopped after a fatal error (${fatalError})`
				: "not started: the run was interrupted",
		}));
	for (const skip of notStarted) log(`skipped ${skip.path}: ${skip.reason}`);
	return { documents: results.filter(Boolean), skipped: [...skipped, ...notStarted], fatalError };
}
