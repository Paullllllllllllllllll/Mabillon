import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { main as piMain } from "@earendil-works/pi-coding-agent";
import { createTuiExtension } from "./agent/tui-extension.ts";
import {
	type ChronoConfig,
	coerceConfigValue,
	findConfigFile,
	loadConfigFile,
	type Mode,
	mergeConfig,
	normalizeKey,
} from "./config.ts";
import { type DocumentResult, run } from "./driver.ts";
import { OUTPUT_DIR_NAME } from "./inputs/discover.ts";
import { loadTextDocument } from "./inputs/text.ts";
import {
	DEFAULT_TRANSCRIPTION_SCHEMA,
	type LoadedSchema,
	listSchemas,
	loadSchemaFile,
	resolveSchema,
	schemaLoadErrors,
} from "./schemas/registry.ts";
import { collectStatus } from "./status.ts";
import { errorMessage, readPackageVersion, readUtf8File } from "./util.ts";
import { formatIssues, type Issue } from "./verify/issues.ts";
import { verifyTranscriptionPage, verifyUnitContent } from "./verify/verify.ts";

const HELP = `Mabillon ${readPackageVersion()}: agentic transcription and schema-validated extraction

Usage:
  mabillon transcribe <pdf|image|folder>... [options]
  mabillon extract <pdf|image|folder|text file>... --schema <name|path> [options]
  mabillon verify <file> [--schema <name|path>] [--source <text file>]
  mabillon schemas [--schemas-dir <dir>]
  mabillon status [output dir]     progress of runs, read from their state (no model needed)
  mabillon tui [pi options]        interactive pi session with Mabillon tools (/login lives here)

Model:
  --model <provider/id>        e.g. openai/gpt-6-luna, anthropic/claude-opus-4-8
  --thinking <level>           off | minimal | low | medium | high | xhigh | max
  --service-tier <tier>        OpenAI service tier: flex | priority | auto | default (OpenAI API key only;
                               flex costs half and is slower)

Work organization:
  --units-per-session <n>      pages/chunks per agent session (default 20)
  --compact-at <tokens>        compact the context at the next unit boundary above this size (default 250000)
  --tool-cap <n>               tool calls per unit before only write/edit/verify remain (default 30)
  --tool-hard-cap <n>          tool calls per unit before it is closed for review (default 40)
  --units <selection>          only these pages/chunks, e.g. "1-20,25"
  --concurrency <n>            documents processed in parallel (default 1)

Inputs and context:
  --schema <name|path>         schema (transcription default: diplomatic_markdown_transcription)
  --schemas-dir <dir>          additional schema directory (repeatable)
  --context <file>             context text for every document (repeatable)
  --context-image <file>       context image for every document (repeatable)
  --no-auto-context            do not pick up context.md / <stem>.context.md / context*.png next to inputs
  --dpi <n>                    PDF render resolution (default 300)
  --image-quality <level>      max (default; each provider's full-resolution mode), high, or standard
  --max-image-px <n>           cap the longest edge of images sent to the model (default: model limit)
  --chunk-tokens <n>           approximate size of text chunks (default 2500)
  --grounding-threshold <x>    share of a verbatim field's word trigrams that must occur in the source
                               text; below it a grounding warning is recorded (default 0.8)

OpenRouter (models named openrouter/<vendor>/<model>):
  --no-zdr                     also allow endpoints that retain data (default: zero data retention only)
  --openrouter-providers <list>
                               upstream providers, tried in order without fallback (e.g. deepinfra,together)
  --openrouter-quantizations <list>
                               precisions the providers may serve (e.g. fp8,bf16)

Output and runs:
  --out <dir>                  output directory (default: mabillon_output next to each input)
  --force                      discard existing work for the documents and start over
  --redo-review                re-run units that were closed for review
  --tools <list>               the agent's tools, comma-separated (default read,write,edit,view,verify,
                               add_entries,update_entry; also bash, python; tools that do not apply are left out)
  --bash                       add bash (a shell, not sandboxed) to the tools; --no-bash removes it
  --python                     add python (image units: scripts on the page images) to the tools; --no-python
                               removes it
  --python-path <path>         Python interpreter for the python tool (default python; needs numpy and Pillow)
  --python-timeout <seconds>   time limit of one python call (default 120)
  --no-python-sandbox          run python scripts unsandboxed, with your user's permissions (default: in the
                               OS sandbox, without network, writing only to scratch/)
  --no-image-fallback          fail a document instead of lowering image fidelity when the provider rejects it
  --allow-partial-ranges       accept line-range files that leave source lines uncovered
  --keep-session-images        keep page images in the saved session logs (large)
  --verbose                    print tool calls and assistant messages
  --json                       print a machine-readable result on stdout (progress stays on stderr)
  --quiet, -q                  no progress output
  --config <file>              settings file (default: ./mabillon.yaml if present)
  --json, --quiet, --config and --source are command-line only; every other option can also be set in the yaml.

Exit codes: 0 every selected unit committed; 1 incomplete or failed documents (or verify errors);
2 usage, configuration or credential error; 3 finished, but some units were closed for human review;
130 interrupted (state is saved; rerun the same command to resume). status: 1 when no runs are found,
2 when the path does not exist.

Credentials and models are shared with pi (~/.pi/agent). Log in once with \`mabillon tui\` and /login.`;

interface ParsedArgs {
	command?: string;
	positionals: string[];
	overrides: Partial<ChronoConfig>;
	configPath?: string;
	source?: string;
	/** Print a machine-readable JSON result on stdout (progress stays on stderr). */
	json: boolean;
	/** Suppress progress output on stderr. */
	quiet: boolean;
	help: boolean;
	version: boolean;
}

const FLAG_ALIASES: Record<string, string> = {
	"compact-at": "compactAtTokens",
	"tool-cap": "toolSoftCap",
	"context-image": "contextImages",
	"schemas-dir": "schemasDirs",
	"schema-dir": "schemasDirs",
};

const BOOLEAN_FLAGS = new Set([
	"force",
	"redoReview",
	"verbose",
	"bash",
	"python",
	"pythonSandbox",
	"autoContext",
	"keepSessionImages",
	"imageFallback",
	"allowPartialRanges",
	"zdr",
]);

/** --json, or --json=<true|1|yes|on>. */
function isJsonFlag(arg: string): boolean {
	if (arg === "--json") return true;
	return arg.startsWith("--json=") && ["true", "1", "yes", "on"].includes(arg.slice("--json=".length).toLowerCase());
}

export function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = {
		positionals: [],
		overrides: {},
		json: false,
		quiet: false,
		help: false,
		version: false,
	};
	const cwd = process.cwd();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-h" || arg === "--help") {
			parsed.help = true;
			continue;
		}
		if (arg === "-v" || arg === "--version") {
			parsed.version = true;
			continue;
		}
		if (arg === "--json" || arg.startsWith("--json=")) {
			parsed.json = isJsonFlag(arg);
			continue;
		}
		if (arg === "-q" || arg === "--quiet") {
			parsed.quiet = true;
			continue;
		}
		if (!arg.startsWith("--")) {
			if (!parsed.command) parsed.command = arg;
			else parsed.positionals.push(arg);
			continue;
		}
		let name = arg.slice(2);
		let inlineValue: string | undefined;
		const eq = name.indexOf("=");
		if (eq >= 0) {
			inlineValue = name.slice(eq + 1);
			name = name.slice(0, eq);
		}
		const takeValue = (): string => {
			if (inlineValue !== undefined) return inlineValue;
			const value = argv[++i];
			if (value === undefined) throw new Error(`--${name} needs a value`);
			return value;
		};
		if (name === "config") {
			parsed.configPath = takeValue();
			continue;
		}
		if (name === "source") {
			parsed.source = takeValue();
			continue;
		}
		if (name.startsWith("no-")) {
			const key = normalizeKey(FLAG_ALIASES[name.slice(3)] ?? name.slice(3));
			if (!key || !BOOLEAN_FLAGS.has(key)) throw new Error(`Unknown option --${name}`);
			(parsed.overrides as Record<string, unknown>)[key] = false;
			continue;
		}
		const key = normalizeKey(FLAG_ALIASES[name] ?? name);
		if (!key) throw new Error(`Unknown option --${name}`);
		if (BOOLEAN_FLAGS.has(key)) {
			(parsed.overrides as Record<string, unknown>)[key] =
				inlineValue === undefined ? true : coerceConfigValue(key, inlineValue, cwd);
			continue;
		}
		const value = coerceConfigValue(key, takeValue(), cwd);
		const overrides = parsed.overrides as Record<string, unknown>;
		if (Array.isArray(value)) overrides[key] = [...((overrides[key] as unknown[]) ?? []), ...value];
		else overrides[key] = value;
	}
	return parsed;
}

function loadConfig(parsed: ParsedArgs): ChronoConfig {
	const file = findConfigFile(parsed.configPath, process.cwd());
	return mergeConfig(file ? loadConfigFile(file) : {}, parsed.overrides);
}

function createLogger(quiet: boolean): (message: string) => void {
	return (message) => {
		if (quiet) return;
		const time = new Date().toTimeString().slice(0, 8);
		process.stderr.write(`[${time}] ${message}\n`);
	};
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Report a usage or configuration error: as JSON on stdout with --json, otherwise on stderr. */
function fail(parsed: ParsedArgs, message: string, code = 2): number {
	if (parsed.json) printJson({ ok: false, exit_code: code, error: message });
	else process.stderr.write(`${message}\n`);
	return code;
}

export type DocumentStatusLabel = "complete" | "needs_review" | "incomplete" | "failed";

function documentStatus(doc: DocumentResult): DocumentStatusLabel {
	if (doc.error) return "failed";
	if (doc.pending > 0) return "incomplete";
	// The merged output does not validate against the schema.
	if (doc.finalValidation?.length) return "failed";
	return doc.needsReview > 0 ? "needs_review" : "complete";
}

function documentJson(doc: DocumentResult) {
	return {
		stem: doc.stem,
		source: doc.source,
		status: documentStatus(doc),
		output_dir: doc.outputDir,
		outputs: doc.outputs ?? {},
		units_total: doc.units,
		units_selected: doc.selected,
		units_committed: doc.committed,
		units_needs_review: doc.reviewUnits,
		units_pending: doc.pending,
		cost: Number(doc.cost.toFixed(6)),
		...(doc.tools ? { tools: doc.tools } : {}),
		...(doc.warnings?.length ? { warnings: doc.warnings } : {}),
		...(doc.finalValidation?.length ? { final_validation: doc.finalValidation } : {}),
		...(doc.error ? { error: doc.error } : {}),
	};
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

async function runCommand(mode: Mode, parsed: ParsedArgs): Promise<number> {
	if (parsed.positionals.length === 0) return fail(parsed, `No inputs given. Run \`mabillon --help\`.`);
	let config: ChronoConfig;
	try {
		config = loadConfig(parsed);
	} catch (error) {
		return fail(parsed, errorMessage(error));
	}
	const log = createLogger(parsed.quiet);
	const controller = new AbortController();
	let interrupted = false;
	const onSignal = () => {
		if (interrupted) process.exit(130);
		interrupted = true;
		log("Interrupted: finishing the current step and saving state (signal again to exit immediately)");
		controller.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		let summary: Awaited<ReturnType<typeof run>>;
		try {
			summary = await run({ mode, inputs: parsed.positionals, config, log, signal: controller.signal });
		} catch (error) {
			return fail(parsed, errorMessage(error));
		}
		// Interrupted before the first document started: no documents, but still exit code 130.
		if (summary.documents.length === 0 && !interrupted) {
			const reasons = summary.skipped.map((skip) => `${skip.path}: ${skip.reason}`).join("; ");
			return fail(parsed, `No supported documents found${reasons ? ` (${reasons})` : ""}.`);
		}
		const counts = { complete: 0, needs_review: 0, incomplete: 0, failed: 0 };
		for (const doc of summary.documents) counts[documentStatus(doc)]++;
		const totalCost = summary.documents.reduce((sum, doc) => sum + doc.cost, 0);
		log(
			`Done: ${counts.complete} complete, ${counts.needs_review} with units to review, ${counts.incomplete} incomplete, ${counts.failed} failed; total cost $${totalCost.toFixed(4)}`,
		);
		if (summary.fatalError) log(`Stopped: ${summary.fatalError}`);
		const code = runExitCode(summary.documents, interrupted, summary.fatalError !== undefined);
		if (parsed.json) {
			printJson({
				ok: code === 0,
				exit_code: code,
				mode,
				schema: config.schema ?? (mode === "transcribe" ? DEFAULT_TRANSCRIPTION_SCHEMA : undefined),
				...(summary.fatalError ? { error: summary.fatalError } : {}),
				...(interrupted ? { interrupted: true } : {}),
				documents: summary.documents.map(documentJson),
				skipped: summary.skipped,
				total_cost: Number(totalCost.toFixed(6)),
			});
		}
		return code;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

const PAGE_META_KEYS = new Set([
	"page",
	"unit",
	"status",
	"source_image",
	"image_page",
	"pdf_page",
	"closed_reason",
	"parse_error",
	"issues",
	"integrity_error",
	"session",
	"hard_cap_closed",
	"soft_cap_blocks",
]);

function readJsonFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Schema recorded by Mabillon for an output file (in the file itself or its .provenance.json). */
interface RecordedSchema {
	name: string;
	path?: string;
	sha256?: string;
}

function recordedSchema(path: string, data: unknown): RecordedSchema | undefined {
	const fromMetadata = (value: unknown): RecordedSchema | undefined => {
		const schema = (
			value as { mabillon?: { schema?: { name?: unknown; path?: unknown; sha256?: unknown } } } | undefined
		)?.mabillon?.schema;
		if (typeof schema?.name !== "string") return undefined;
		return {
			name: schema.name,
			path: typeof schema.path === "string" ? schema.path : undefined,
			sha256: typeof schema.sha256 === "string" ? schema.sha256 : undefined,
		};
	};
	const own = fromMetadata(data);
	if (own) return own;
	const stem = basename(path, extname(path));
	for (const candidate of [join(dirname(path), `${stem}.provenance.json`), join(dirname(path), `${stem}.json`)]) {
		if (candidate === path || !existsSync(candidate)) continue;
		const found = fromMetadata(readJsonFile(candidate));
		if (found) return found;
	}
	return undefined;
}

function loadVerifySchema(
	spec: string | undefined,
	mode: Mode,
	config: ChronoConfig,
	recorded?: RecordedSchema,
): LoadedSchema {
	if (spec && existsSync(spec)) return loadSchemaFile(resolve(spec));
	if (spec) return resolveSchema(spec, mode, config.schemasDirs);
	if (recorded) {
		// The exact schema file of the run, if it is still there unchanged; otherwise look the name up.
		if (recorded.path && existsSync(recorded.path)) {
			try {
				const file = loadSchemaFile(recorded.path);
				if (!recorded.sha256 || file.sha256 === recorded.sha256) return file;
			} catch {
				// fall back to the name
			}
		}
		return resolveSchema(recorded.name, mode, config.schemasDirs);
	}
	return resolveSchema(undefined, mode, config.schemasDirs);
}

async function verifyCommand(parsed: ParsedArgs): Promise<number> {
	const file = parsed.positionals[0];
	if (!file) return fail(parsed, "Usage: mabillon verify <file> [--schema <name|path>] [--source <text file>]");
	try {
		const config = loadConfig(parsed);
		const path = resolve(file);
		if (!existsSync(path)) return fail(parsed, `File not found: ${path}`);
		const read = readUtf8File(path);
		let content = read.text;
		const isMarkdown = extname(path).toLowerCase() === ".md";
		let data: unknown;
		if (!isMarkdown) {
			try {
				data = JSON.parse(content);
			} catch {
				data = undefined;
			}
		}
		const transcriptionOutput =
			!!data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).pages);
		// A merged transcript (<stem>.md without front matter) is checked as one body.
		const mergedTranscript = isMarkdown && !/^﻿?---[ \t]*\r?\n/.test(content);
		if (mergedTranscript) content = `---\n---\n${content}`;
		const mode: Mode = isMarkdown || transcriptionOutput ? "transcribe" : "extract";
		// The schema recorded with an output wins over mabillon.yaml; only --schema on the command line overrides it.
		const recorded = recordedSchema(path, data);
		const spec = parsed.overrides.schema ?? (recorded ? undefined : config.schema);
		const schema = loadVerifySchema(spec, mode, config, recorded);
		let issues: Issue[];
		if (transcriptionOutput) {
			const fields = Object.keys((schema.schema.properties ?? {}) as object);
			issues = ((data as { pages: Array<Record<string, unknown>> }).pages ?? []).flatMap((page, index) => {
				if (page.status === "pending") return [];
				const object = Object.fromEntries(
					Object.entries(page).filter(([key]) => !PAGE_META_KEYS.has(key) || fields.includes(key)),
				);
				return verifyTranscriptionPage(schema, object).issues.map((issue) => ({
					...issue,
					pointer: `/pages/${index}${issue.pointer && issue.pointer !== "/" ? issue.pointer : ""}`,
				}));
			});
		} else {
			const sourceText = parsed.source ? (await loadTextDocument(resolve(parsed.source))).text : undefined;
			issues = verifyUnitContent({
				schema,
				content,
				sourceText,
				groundingThreshold: config.groundingThreshold,
			}).issues;
			if (mergedTranscript) {
				// Schema fields of a single unit do not apply to a merged transcript; keep the text checks.
				issues = issues.filter((issue) => issue.layer !== "schema" && issue.layer !== "parse");
			}
		}
		if (!read.valid) {
			// Bytes that are not UTF-8 were replaced while decoding; the file as written is not valid.
			issues.unshift({
				severity: "error",
				layer: "parse",
				message: "the file is not valid UTF-8 (probably written with another encoding); characters were lost",
			});
		}
		const errors = issues.filter((issue) => issue.severity === "error").length;
		const code = errors > 0 ? 1 : 0;
		if (parsed.json) {
			printJson({
				ok: errors === 0,
				exit_code: code,
				file: path,
				schema: schema.name,
				errors,
				warnings: issues.length - errors,
				issues,
			});
		} else {
			process.stdout.write(
				`${file} against ${schema.name}: ${errors} error(s), ${issues.length - errors} warning(s)\n${formatIssues(issues, 200)}\n`,
			);
		}
		return code;
	} catch (error) {
		return fail(parsed, errorMessage(error));
	}
}

function schemasCommand(parsed: ParsedArgs): number {
	try {
		const config = loadConfig(parsed);
		const schemas = listSchemas(config.schemasDirs);
		if (parsed.json) {
			printJson({
				ok: true,
				exit_code: 0,
				schemas: schemas.map((schema) => ({
					name: schema.name,
					kind: schema.kind,
					bundled: schema.bundled,
					path: schema.path,
					verbatim_fields: schema.rules.verbatimFields ?? [],
				})),
				load_errors: schemaLoadErrors.map((problem) => ({ path: problem.path, error: problem.error })),
			});
			return 0;
		}
		for (const schema of schemas) {
			const extras = schema.rules.verbatimFields?.length
				? `  verbatim: ${schema.rules.verbatimFields.join(", ")}`
				: "";
			process.stdout.write(
				`${schema.name.padEnd(46)} ${schema.kind.padEnd(13)} ${schema.bundled ? "bundled" : "user   "}  ${schema.path}${extras}\n`,
			);
		}
		for (const problem of schemaLoadErrors) process.stdout.write(`could not load: ${problem.error}\n`);
		return 0;
	} catch (error) {
		return fail(parsed, errorMessage(error));
	}
}

function statusCommand(parsed: ParsedArgs): number {
	try {
		// Without a path, the output folder of mabillon.yaml (out:) or --out, as for runs.
		const path = parsed.positionals[0] ?? loadConfig(parsed).out ?? OUTPUT_DIR_NAME;
		const documents = collectStatus(path);
		if (documents.length === 0) return fail(parsed, `No Mabillon runs found under ${resolve(path)}.`, 1);
		if (parsed.json) {
			printJson({
				ok: true,
				exit_code: 0,
				documents: documents.map((doc) => ({
					stem: doc.stem,
					source: doc.source,
					mode: doc.mode,
					schema: doc.schema,
					output_dir: doc.outputDir,
					running: doc.running,
					complete: doc.complete,
					...(doc.incompleteReason ? { incomplete_reason: doc.incompleteReason } : {}),
					units_total: doc.units,
					units_committed: doc.committed,
					units_needs_review: doc.needsReview,
					units_pending: doc.pending,
					...(doc.damaged.length > 0 ? { units_damaged: doc.damaged } : {}),
					...(doc.finalValidation?.length ? { final_validation: doc.finalValidation } : {}),
					...(doc.exportError ? { export_error: doc.exportError } : {}),
					sessions: doc.sessions,
					cost: doc.cost,
					updated_at: doc.updatedAt,
					...(doc.warnings?.length ? { warnings: doc.warnings } : {}),
					...(doc.lastError ? { last_error: doc.lastError } : {}),
				})),
			});
			return 0;
		}
		for (const doc of documents) {
			const review =
				doc.needsReview.length > 0 ? `, needs review: ${doc.needsReview.map((item) => item.unit).join(", ")}` : "";
			const running = doc.running ? " (running)" : "";
			const damaged =
				doc.damaged.length > 0
					? ` (damaged: ${doc.damaged.map((item) => `${item.unit}: ${item.error}`).join(", ")})`
					: "";
			const exported = doc.exportError
				? `; export failed: ${doc.exportError}`
				: doc.finalValidation?.length
					? `; merged output invalid: ${doc.finalValidation.join("; ")}`
					: "";
			process.stdout.write(
				`${doc.stem}${running} [${doc.mode}, ${doc.schema}] ${doc.committed}/${doc.units} committed, ${doc.pending} pending${damaged}${review}; ${doc.sessions} session(s), $${doc.cost.toFixed(4)}${exported}${doc.lastError ? `; last error: ${doc.lastError}` : ""}\n`,
			);
		}
		return 0;
	} catch (error) {
		return fail(parsed, errorMessage(error));
	}
}

async function tuiCommand(argv: string[]): Promise<number> {
	const index = argv.indexOf("tui");
	const piArgs = argv.slice(index + 1);
	let config: ChronoConfig;
	try {
		const file = findConfigFile(undefined, process.cwd());
		config = mergeConfig(file ? loadConfigFile(file) : {});
	} catch (error) {
		process.stderr.write(`${errorMessage(error)}\n`);
		return 2;
	}
	await piMain(piArgs, { extensionFactories: [{ name: "mabillon", factory: createTuiExtension(config) }] });
	return 0;
}

export async function cli(argv: string[]): Promise<number> {
	if (argv[0] === "tui") return tuiCommand(argv);
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		const message = errorMessage(error);
		if (argv.some(isJsonFlag)) printJson({ ok: false, exit_code: 2, error: message });
		else process.stderr.write(`${message}\n`);
		return 2;
	}
	if (parsed.version) {
		if (parsed.json) printJson({ ok: true, exit_code: 0, version: readPackageVersion() });
		else process.stdout.write(`${readPackageVersion()}\n`);
		return 0;
	}
	if (parsed.help || !parsed.command) {
		if (parsed.json && !parsed.help) return fail(parsed, "No command given. Run `mabillon --help`.");
		if (parsed.json) {
			printJson({ ok: true, exit_code: 0, help: HELP });
			return 0;
		}
		process.stdout.write(`${HELP}\n`);
		return parsed.command || parsed.help ? 0 : 2;
	}
	switch (parsed.command) {
		case "transcribe":
			return runCommand("transcribe", parsed);
		case "extract":
			return runCommand("extract", parsed);
		case "verify":
			return await verifyCommand(parsed);
		case "schemas":
			return schemasCommand(parsed);
		case "status":
			return statusCommand(parsed);
		default:
			return fail(parsed, `Unknown command "${parsed.command}". Run \`mabillon --help\`.`);
	}
}
