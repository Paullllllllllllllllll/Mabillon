import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { IMAGE_QUALITIES, type ImageQuality } from "./inputs/image-profile.ts";

export type Mode = "transcribe" | "extract";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** OpenAI service tiers (the `service_tier` request field); only for OpenAI models used with an API key. */
export const SERVICE_TIERS = ["flex", "priority", "auto", "default"] as const;
export type ServiceTier = (typeof SERVICE_TIERS)[number];

export interface ChronoConfig {
	/** Model as "provider/id" (or any pattern pi's --model accepts). Falls back to pi's default model. */
	model?: string;
	/** Reasoning effort. Falls back to pi's default thinking level. */
	thinking?: ThinkingLevel;
	/** OpenAI service tier sent with every request (OpenAI API key only; flex halves the price). */
	serviceTier?: ServiceTier;
	/** Output root. Without it the outputs go beside each input. */
	out?: string;
	/**
	 * Write ChronoTranscriber's (transcribe) or ChronoMiner's (extract) files and store, so that the tools can render,
	 * repair and resume the documents. Off: Mabillon's own files from the committed units, and no store is touched.
	 */
	chrono: boolean;
	/** Output layout below `out`: transcription hash (default) or mirror, extraction flat (default) or mirror. */
	layout?: string;
	/** Rendered formats: transcription txt (default) and md, extraction json (always) and csv. */
	formats?: string[];
	/** Schema name (bundled or from schemasDirs) or path. */
	schema?: string;
	/** Additional directories searched for schemas (wrapper format {name, strict, schema}). */
	schemasDirs: string[];
	/** Pages/chunks handled by one agent session before a fresh session takes over. */
	unitsPerSession: number;
	/** Context size (tokens) above which the conversation is compacted at the next unit boundary. */
	compactAtTokens: number;
	/** Tool calls per unit after which only write, edit and verify remain available. */
	toolSoftCap: number;
	/** Tool calls per unit after which the unit is closed as needs_review. */
	toolHardCap: number;
	/** How often an agent that stops early is told to continue before the session is ended. */
	settleRetries: number;
	/** Resolution used to render PDF pages. */
	dpi: number;
	/** Upper bound on rendered page size in pixels (width x height). */
	maxRenderPixels: number;
	/** Image fidelity: "max" uses each provider's full-resolution mode, "high" a cheaper high-detail mode,
	 * "standard" pi's defaults (2,000 px, provider-chosen detail). */
	imageQuality: ImageQuality;
	/** Optional cap on the longest edge of images sent to the model (default: the model's own limit). */
	maxImagePx?: number;
	/** Approximate size of text chunks for text inputs. */
	chunkTokens: number;
	/** Documents processed in parallel. */
	concurrency: number;
	/** Context text files applied to every document. */
	context: string[];
	/** Context images applied to every document. */
	contextImages: string[];
	/** Pick up <stem>.context.md / context.md and matching context images next to inputs. */
	autoContext: boolean;
	/** 1-based selection of pages/chunks, e.g. "1-20,25". */
	units?: string;
	/** Discard existing work for a document and start over. */
	force: boolean;
	/** Re-run units previously closed as needs_review. */
	redoReview: boolean;
	/** The agent's tool set (see TOOL_NAMES); default DEFAULT_TOOLS. Tools that do not apply to a unit are left out. */
	tools?: string[];
	/** true adds bash to the tool set, false removes it (the default set has no bash). */
	bash?: boolean;
	/** true adds python (image units) to the tool set, false removes it (the default set has no python). */
	python?: boolean;
	/** Python interpreter for the python tool (needs numpy and Pillow; OpenCV is used when present). */
	pythonPath: string;
	/** Seconds a python tool call may run before it is stopped. */
	pythonTimeout: number;
	/** Run the python tool's scripts in the OS sandbox (no network, writes only to scratch/); false runs them as you. */
	pythonSandbox: boolean;
	/** Fall back to a lower image fidelity when a provider rejects the image parameters (false: fail the document). */
	imageFallback: boolean;
	/** Accept ChronoMiner line ranges that leave source lines uncovered (recorded in the metadata). */
	allowPartialRanges: boolean;
	/** Minimum share of a verbatim field's word trigrams that must occur in the source text. */
	groundingThreshold: number;
	/** Print tool calls and assistant text while running. */
	verbose: boolean;
	/** Keep base64 images in the saved pi session logs (large; off by default). */
	keepSessionImages: boolean;
	/** OpenRouter: route only to zero-data-retention endpoints (default on). */
	zdr: boolean;
	/** OpenRouter: upstream providers to use, in order, with no fallback to others (e.g. ["deepinfra", "together"]). */
	openrouterProviders?: string[];
	/** OpenRouter: quantization levels the upstream providers may serve (e.g. ["fp8", "bf16"]). */
	openrouterQuantizations?: string[];
	/**
	 * Correction mode: a chronotranscriber.sqlite (transcribe) or chronominer.sqlite (extract), or an output root
	 * holding it, whose stored units seed the unit files of a fresh run; the agent corrects them.
	 */
	drafts?: string;
	/** Correction mode: the store document to take the drafts from when several match the input. */
	draftsDocument?: string;
}

export const DEFAULT_CONFIG: ChronoConfig = {
	chrono: false,
	schemasDirs: [],
	unitsPerSession: 20,
	compactAtTokens: 250_000,
	toolSoftCap: 30,
	toolHardCap: 40,
	settleRetries: 3,
	dpi: 300,
	maxRenderPixels: 30_000_000,
	imageQuality: "max",
	chunkTokens: 2500,
	concurrency: 1,
	context: [],
	contextImages: [],
	autoContext: true,
	force: false,
	redoReview: false,
	pythonPath: "python",
	pythonTimeout: 120,
	pythonSandbox: true,
	imageFallback: true,
	allowPartialRanges: false,
	groundingThreshold: 0.8,
	verbose: false,
	keepSessionImages: false,
	zdr: true,
};

const KEY_ALIASES: Record<string, keyof ChronoConfig> = {
	model: "model",
	thinking: "thinking",
	reasoning: "thinking",
	reasoningeffort: "thinking",
	servicetier: "serviceTier",
	out: "out",
	output: "out",
	chrono: "chrono",
	layout: "layout",
	formats: "formats",
	schema: "schema",
	schemasdirs: "schemasDirs",
	schemadirs: "schemasDirs",
	unitspersession: "unitsPerSession",
	pagespersession: "unitsPerSession",
	compactattokens: "compactAtTokens",
	compactat: "compactAtTokens",
	toolsoftcap: "toolSoftCap",
	toolcap: "toolSoftCap",
	toolhardcap: "toolHardCap",
	settleretries: "settleRetries",
	dpi: "dpi",
	maxrenderpixels: "maxRenderPixels",
	maximagepx: "maxImagePx",
	imagequality: "imageQuality",
	chunktokens: "chunkTokens",
	concurrency: "concurrency",
	context: "context",
	contextimages: "contextImages",
	autocontext: "autoContext",
	units: "units",
	force: "force",
	redoreview: "redoReview",
	bash: "bash",
	python: "python",
	pythonpath: "pythonPath",
	pythontimeout: "pythonTimeout",
	pythonsandbox: "pythonSandbox",
	tools: "tools",
	imagefallback: "imageFallback",
	allowpartialranges: "allowPartialRanges",
	groundingthreshold: "groundingThreshold",
	verbose: "verbose",
	keepsessionimages: "keepSessionImages",
	zdr: "zdr",
	openrouterproviders: "openrouterProviders",
	openrouterquantizations: "openrouterQuantizations",
	drafts: "drafts",
	draftsdocument: "draftsDocument",
};

const NUMBER_KEYS = new Set<keyof ChronoConfig>([
	"unitsPerSession",
	"compactAtTokens",
	"toolSoftCap",
	"toolHardCap",
	"settleRetries",
	"dpi",
	"maxRenderPixels",
	"maxImagePx",
	"chunkTokens",
	"concurrency",
	"groundingThreshold",
	"pythonTimeout",
]);
/** Counts and sizes that must be at least 1 (compactAtTokens and settleRetries may be 0). */
const POSITIVE_KEYS = new Set<keyof ChronoConfig>([
	"pythonTimeout",
	"unitsPerSession",
	"toolSoftCap",
	"toolHardCap",
	"dpi",
	"maxRenderPixels",
	"maxImagePx",
	"chunkTokens",
	"concurrency",
]);
const BOOLEAN_KEYS = new Set<keyof ChronoConfig>([
	"chrono",
	"autoContext",
	"force",
	"redoReview",
	"bash",
	"python",
	"pythonSandbox",
	"imageFallback",
	"allowPartialRanges",
	"verbose",
	"keepSessionImages",
	"zdr",
]);
const LIST_KEYS = new Set<keyof ChronoConfig>(["schemasDirs", "context", "contextImages"]);
const PATH_KEYS = new Set<keyof ChronoConfig>(["out", "schemasDirs", "context", "contextImages", "drafts"]);

/** Quantization levels OpenRouter can filter providers by. */
export const OPENROUTER_QUANTIZATIONS = [
	"int4",
	"int8",
	"fp4",
	"fp6",
	"fp8",
	"fp16",
	"bf16",
	"fp32",
	"unknown",
] as const;

/** Rendered formats: txt and md for transcription, json and csv for extraction. */
const OUTPUT_FORMATS = ["txt", "md", "json", "csv"];
/** Layouts: hash and mirror for transcription (ChronoTranscriber), flat and mirror for extraction (ChronoMiner). */
const LAYOUTS = ["hash", "flat", "mirror"];

/** The formats and layout of a mode, with its defaults; refuses those of the other mode. */
export function outputSettings(
	config: Pick<ChronoConfig, "formats" | "layout">,
	mode: Mode,
): { formats: string[]; layout: string } {
	const own = mode === "transcribe" ? ["txt", "md"] : ["json", "csv"];
	// ChronoTranscriber's and ChronoMiner's defaults: txt alone (a .md beside the .txt would give ChronoMiner two
	// inputs of one name), json.
	const formats = config.formats ?? (mode === "transcribe" ? ["txt"] : ["json"]);
	const foreign = formats.filter((format) => !own.includes(format));
	if (foreign.length > 0) {
		throw new Error(
			`--formats ${foreign.join(",")} does not apply to ${mode === "transcribe" ? "transcription (txt, md)" : "extraction (json, csv)"}`,
		);
	}
	const layout = config.layout ?? (mode === "transcribe" ? "hash" : "flat");
	const layouts = mode === "transcribe" ? ["hash", "mirror"] : ["flat", "mirror"];
	if (!layouts.includes(layout)) {
		throw new Error(
			`--layout ${layout} does not apply to ${mode === "transcribe" ? "transcription" : "extraction"} (${layouts.join(" or ")})`,
		);
	}
	return { formats, layout };
}

/** A comma-separated string or a YAML list of names (trimmed, empty entries dropped, duplicates removed). */
function parseNameList(value: unknown): string[] {
	const names = (Array.isArray(value) ? value.map(String) : String(value).split(","))
		.map((name) => name.trim())
		.filter((name) => name !== "");
	return [...new Set(names)];
}

/** Tools the agent can be given. */
export const TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"bash",
	"view",
	"python",
	"verify",
	"add_entries",
	"update_entry",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** The default tool set (bash and python are opt-in). */
export const DEFAULT_TOOLS: ToolName[] = ["read", "write", "edit", "view", "verify", "add_entries", "update_entry"];

function parseTools(value: unknown): ToolName[] {
	const names = (Array.isArray(value) ? value.map(String) : String(value).split(","))
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name !== "");
	const unknown = names.filter((name) => !(TOOL_NAMES as readonly string[]).includes(name));
	if (unknown.length > 0) {
		throw new Error(`Config "tools": unknown tool ${unknown.join(", ")} (known: ${TOOL_NAMES.join(", ")})`);
	}
	if (!names.includes("verify")) throw new Error('Config "tools" must include verify (it commits the units)');
	return [...new Set(names)] as ToolName[];
}

/**
 * The tools a session gets: the configured set (default DEFAULT_TOOLS), with --bash/--no-bash and
 * --python/--no-python applied, minus tools that do not apply here (view and python only for image units, add_entries
 * and update_entry only in extraction with an entries schema). Returned in TOOL_NAMES order.
 */
export function effectiveTools(
	config: Pick<ChronoConfig, "tools" | "bash" | "python">,
	where: { mode: Mode; inputKind: "images" | "text"; entries: boolean },
): ToolName[] {
	const wanted = new Set<ToolName>(config.tools ? parseTools(config.tools) : DEFAULT_TOOLS);
	if (config.bash === true) wanted.add("bash");
	if (config.bash === false) wanted.delete("bash");
	if (config.python === true) wanted.add("python");
	if (config.python === false) wanted.delete("python");
	if (where.inputKind !== "images") {
		wanted.delete("view");
		wanted.delete("python");
	}
	if (where.mode !== "extract" || !where.entries) {
		wanted.delete("add_entries");
		wanted.delete("update_entry");
	}
	return TOOL_NAMES.filter((name) => wanted.has(name));
}

/**
 * Refuse tool sets an agent cannot work with: verify always, view or python for image units and read for text units
 * are required (without them the agent cannot see the unit again or look ahead), and some tool must create the unit
 * file (transcription: write; extraction: write or add_entries).
 */
export function checkToolSet(tools: readonly ToolName[], where: { mode: Mode; inputKind: "images" | "text" }): void {
	const has = (name: ToolName) => tools.includes(name);
	const kind = where.inputKind === "images" ? "image" : "text";
	const missing = [
		...(has("verify") ? [] : ["verify"]),
		...(where.inputKind === "images" && !has("view") && !has("python") ? ["view (or python)"] : []),
		...(where.inputKind === "text" && !has("read") ? ["read"] : []),
	];
	if (missing.length > 0) {
		throw new Error(
			`Config "tools": ${missing.join(" and ")} cannot be left out for ${where.mode === "extract" ? "extraction" : "transcription"} of ${kind} units`,
		);
	}
	// bash is an add-on, never the only writer: it is an inspection tool that the soft cap takes away.
	const creators: ToolName[] = where.mode === "extract" ? ["write", "add_entries"] : ["write"];
	if (!creators.some(has)) {
		throw new Error(
			`Config "tools": no tool can create the unit file (${where.mode === "extract" ? "extraction" : "transcription"} needs ${creators.join(" or ")}; bash cannot be the only one)`,
		);
	}
}

export function normalizeKey(key: string): keyof ChronoConfig | undefined {
	return KEY_ALIASES[key.replace(/[-_\s]/g, "").toLowerCase()];
}

/** Coerce and validate one config value. Relative paths are resolved against `baseDir`. */
export function coerceConfigValue(key: keyof ChronoConfig, value: unknown, baseDir: string): unknown {
	if (key === "groundingThreshold") {
		// No separator stripping: "0,8" must not become 8.
		const text = String(value).trim();
		const num = typeof value === "number" ? value : text === "" ? Number.NaN : Number(text);
		if (!Number.isFinite(num) || num <= 0 || num > 1) {
			throw new Error(
				`Config "groundingThreshold" must be a number above 0 and at most 1 (e.g. 0.8), not "${value}"`,
			);
		}
		return num;
	}
	if (NUMBER_KEYS.has(key)) {
		// Thousands separators are allowed in counts ("250,000", "250_000").
		const text = String(value).trim().replace(/[_,]/g, "");
		const num = typeof value === "number" ? value : text === "" ? Number.NaN : Number(text);
		if (!Number.isFinite(num) || num < 0) throw new Error(`Config "${key}" must be a non-negative number`);
		if (POSITIVE_KEYS.has(key) && num < 1) throw new Error(`Config "${key}" must be at least 1, not "${value}"`);
		return num;
	}
	if (BOOLEAN_KEYS.has(key)) {
		if (typeof value === "boolean") return value;
		const text = String(value).toLowerCase();
		if (["true", "yes", "1", "on"].includes(text)) return true;
		if (["false", "no", "0", "off"].includes(text)) return false;
		throw new Error(`Config "${key}" must be true or false`);
	}
	if (key === "tools") return parseTools(value);
	if (key === "formats") {
		const formats = parseNameList(value).map((format) => format.toLowerCase());
		const unknown = formats.filter((format) => !OUTPUT_FORMATS.includes(format));
		if (unknown.length > 0 || formats.length === 0) {
			throw new Error(`Config "formats": expected ${OUTPUT_FORMATS.join(", ")}, not "${value}"`);
		}
		return formats;
	}
	if (key === "layout") {
		const layout = String(value).trim().toLowerCase();
		if (!LAYOUTS.includes(layout))
			throw new Error(`Config "layout" must be one of ${LAYOUTS.join(", ")}, not "${value}"`);
		return layout;
	}
	if (key === "openrouterProviders") return parseNameList(value);
	if (key === "openrouterQuantizations") {
		const levels = parseNameList(value).map((level) => level.toLowerCase());
		const unknown = levels.filter((level) => !(OPENROUTER_QUANTIZATIONS as readonly string[]).includes(level));
		if (unknown.length > 0) {
			throw new Error(
				`Config "openrouterQuantizations": unknown level ${unknown.join(", ")} (known: ${OPENROUTER_QUANTIZATIONS.join(", ")})`,
			);
		}
		return [...new Set(levels)];
	}
	if (key === "imageQuality") {
		const quality = String(value).toLowerCase();
		if (!(IMAGE_QUALITIES as readonly string[]).includes(quality)) {
			throw new Error(`Config "imageQuality" must be one of ${IMAGE_QUALITIES.join(", ")}`);
		}
		return quality;
	}
	if (key === "thinking") {
		const level = String(value).toLowerCase();
		if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
			throw new Error(`Config "thinking" must be one of ${THINKING_LEVELS.join(", ")}`);
		}
		return level;
	}
	if (key === "serviceTier") {
		const tier = String(value).trim().toLowerCase();
		if (!(SERVICE_TIERS as readonly string[]).includes(tier)) {
			throw new Error(`Config "serviceTier" must be one of ${SERVICE_TIERS.join(", ")}, not "${value}"`);
		}
		return tier;
	}
	if (LIST_KEYS.has(key)) {
		const list = Array.isArray(value) ? value.map(String) : [String(value)];
		return PATH_KEYS.has(key) ? list.map((item) => resolve(baseDir, item)) : list;
	}
	if (PATH_KEYS.has(key)) return resolve(baseDir, String(value));
	// An interpreter given as a path is relative to the config file; a bare name is looked up on PATH.
	if (key === "pythonPath" && /[\\/]/.test(String(value))) return resolve(baseDir, String(value));
	// A schema given as a file path is relative to the config file (names are looked up as they are).
	if (key === "schema" && /[\\/]|\.json$/i.test(String(value))) return resolve(baseDir, String(value));
	return String(value);
}

/** Load a mabillon.yaml file into a partial config. */
export function loadConfigFile(path: string): Partial<ChronoConfig> {
	const raw = parseYaml(readFileSync(path, "utf8")) as unknown;
	if (raw === null || raw === undefined) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${path}: expected a mapping of settings`);
	const result: Partial<ChronoConfig> = {};
	const baseDir = dirname(resolve(path));
	for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
		const key = normalizeKey(rawKey);
		if (!key) throw new Error(`${path}: unknown setting "${rawKey}"`);
		if (value === null || value === undefined) continue;
		(result as Record<string, unknown>)[key] = coerceConfigValue(key, value, baseDir);
	}
	return result;
}

/** Find the config file: explicit path, else ./mabillon.yaml or ./mabillon.yml. */
export function findConfigFile(explicit: string | undefined, cwd: string): string | undefined {
	if (explicit) {
		const path = resolve(cwd, explicit);
		if (!existsSync(path)) throw new Error(`Config file not found: ${path}`);
		return path;
	}
	for (const name of ["mabillon.yaml", "mabillon.yml"]) {
		const path = resolve(cwd, name);
		if (existsSync(path)) return path;
	}
	return undefined;
}

/** Merge defaults, file settings, and CLI overrides (later wins; lists from CLI are appended). */
export function mergeConfig(...layers: Array<Partial<ChronoConfig>>): ChronoConfig {
	const merged: ChronoConfig = { ...DEFAULT_CONFIG, schemasDirs: [], context: [], contextImages: [] };
	for (const layer of layers) {
		for (const [key, value] of Object.entries(layer) as Array<[keyof ChronoConfig, unknown]>) {
			if (value === undefined) continue;
			if (LIST_KEYS.has(key)) {
				(merged as unknown as Record<string, unknown[]>)[key] = [
					...((merged as unknown as Record<string, unknown[]>)[key] ?? []),
					...(value as unknown[]),
				];
			} else {
				(merged as unknown as Record<string, unknown>)[key] = value;
			}
		}
	}
	if (merged.toolSoftCap > merged.toolHardCap) {
		throw new Error(
			`Config "toolSoftCap" (${merged.toolSoftCap}) must not exceed "toolHardCap" (${merged.toolHardCap}); raise the hard cap with --tool-hard-cap or tool_hard_cap`,
		);
	}
	return merged;
}
