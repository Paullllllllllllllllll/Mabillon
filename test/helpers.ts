import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { FauxProviderRegistration, RegisterFauxProviderOptions } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { afterAll } from "vitest";

/**
 * pi-coding-agent ships with a shrinkwrapped copy of pi-ai, so the faux provider must be registered in that
 * copy's API registry (the one the agent session actually uses), not in the top-level package.
 */
export async function loadRegisterFauxProvider(): Promise<
	(options: RegisterFauxProviderOptions) => FauxProviderRegistration
> {
	const root = process.cwd();
	const nested = join(
		root,
		"node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js",
	);
	const topLevel = join(root, "node_modules/@earendil-works/pi-ai/dist/compat.js");
	const module = (await import(pathToFileURL(existsSync(nested) ? nested : topLevel).href)) as {
		registerFauxProvider: (options: RegisterFauxProviderOptions) => FauxProviderRegistration;
	};
	return module.registerFauxProvider;
}

const FIXTURE_SCHEMAS = join(process.cwd(), "test", "fixtures", "schemas");
/** Extraction schema with verbatim fields (rules file beside it). */
export const RECIPES_SCHEMA = join(FIXTURE_SCHEMAS, "recipe_entries.json");
/** Extraction schema with a running top-level field and page-local fragments. */
export const GUIDE_SCHEMA = join(FIXTURE_SCHEMAS, "guide_listings.json");
/** Transcription schema whose body description documents extra tags and the [illegible] marker. */
export const CATALOGUE_TRANSCRIPTION_SCHEMA = join(FIXTURE_SCHEMAS, "catalogue_transcription.json");

const tempDirs: string[] = [];

// sharp's cache keeps input files open on Windows, which would block their removal.
sharp.cache(false);

// Each test file imports this module afresh, so the hook removes that file's folders when it finishes.
// Removal is best effort: a file still held open must not fail the run.
afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// left for the OS temp cleanup
		}
	}
});

export function tempDir(prefix = "mabillon-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function folders(dir: string, depth = 0): string[] {
	if (depth > 8 || !existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => [join(dir, entry.name), ...folders(join(dir, entry.name), depth + 1)]);
}

/** The working folder `<root>/.mabillon/<document name>/` of the document whose name ends in `stem`. */
/** The names a document's working folder and sidecar take: `<stem>` (transcription), else `<stem>_output` (extraction). */
function namesOf(stem: string): string[] {
	return [stem, `${stem}_output`];
}

export function workingDir(root: string, stem: string): string {
	for (const name of namesOf(stem)) {
		const found = folders(join(root, ".mabillon")).filter(
			(dir) => basename(dir) === name && existsSync(join(dir, "run", "state.json")),
		);
		if (found.length > 1)
			throw new Error(`expected one working folder for ${name} below ${root}, found ${found.length}`);
		if (found.length === 1) return found[0];
	}
	throw new Error(`expected one working folder for ${stem} below ${root}, found 0`);
}

/** The sidecar `<stem>.mabillon.json` (or `<stem>_output.mabillon.json`) below an output root (outside `.mabillon/`). */
export function sidecarFile(root: string, stem: string): string {
	for (const name of namesOf(stem)) {
		const candidates = [root, ...folders(root).filter((dir) => !dir.split(/[\\/]/).includes(".mabillon"))]
			.map((dir) => join(dir, `${name}.mabillon.json`))
			.filter((path) => existsSync(path));
		if (candidates.length > 1) throw new Error(`expected one sidecar ${name}.mabillon.json below ${root}`);
		if (candidates.length === 1) return candidates[0];
	}
	throw new Error(`expected one sidecar ${stem}.mabillon.json below ${root}`);
}

export function readSidecar(root: string, stem: string): any {
	return JSON.parse(readFileSync(sidecarFile(root, stem), "utf8"));
}

/** A rendered file of a document below an output root (outside `.mabillon/`), e.g. `book.txt` or `notes_output.json`. */
export function outputFile(root: string, name: string): string {
	const candidates = [root, ...folders(root).filter((dir) => !dir.split(/[\\/]/).includes(".mabillon"))]
		.map((dir) => join(dir, name))
		.filter((path) => existsSync(path));
	if (candidates.length !== 1) throw new Error(`expected one ${name} below ${root}, found ${candidates.length}`);
	return candidates[0];
}

export function messageText(message: Message | undefined): string {
	if (!message) return "";
	if (message.role === "system") return "";
	if (message.role === "assistant") {
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

export function call(name: string, args: Record<string, unknown>): AssistantMessage {
	return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
		stopReason: "toolUse",
	});
}

export function say(text: string): AssistantMessage {
	return fauxAssistantMessage(text);
}

export type Responder = (context: TranscriptContext) => AssistantMessage;

export interface FauxSetup {
	faux: FauxProviderRegistration;
	modelRuntime: ModelRuntime;
	agentDir: string;
	requests: TranscriptContext[];
	cleanup(): void;
}

/** A model runtime whose only model is a scripted faux model that answers via `responder`. */
export async function createFauxRuntime(responder: Responder, contextWindow = 200_000): Promise<FauxSetup> {
	const agentDir = tempDir("mabillon-agentdir-");
	const registerFauxProvider = await loadRegisterFauxProvider();
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", input: ["text", "image"], contextWindow, maxTokens: 8192 }],
	});
	const requests: TranscriptContext[] = [];
	const step = (context: TranscriptContext) => {
		requests.push(context);
		return responder(context);
	};
	faux.setResponses(Array.from({ length: 2000 }, () => step));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerProvider("faux", {
		baseUrl: faux.models[0].baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	return { faux, modelRuntime, agentDir, requests, cleanup: () => faux.unregister() };
}

/** Write `count` simple page images into a new folder. */
export async function makeImageFolder(dir: string, count: number): Promise<string> {
	mkdirSync(dir, { recursive: true });
	for (let i = 1; i <= count; i++) {
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100"><rect width="800" height="1100" fill="#f4ecd8"/><text x="80" y="150" font-size="48" font-family="serif">Page ${i}</text><text x="80" y="260" font-size="28" font-family="serif">To make a Tart of Hearbs.</text></svg>`;
		await sharp(Buffer.from(svg))
			.png()
			.toFile(join(dir, `scan_${i}.png`));
	}
	return dir;
}

/** Write a minimal, valid multi-page PDF with one line of text per page. */
export function makePdf(path: string, pages: string[]): string {
	const objects: string[] = [];
	const add = (body: string) => {
		objects.push(body);
		return objects.length;
	};
	const catalog = add("");
	const pagesObj = add("");
	const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	const kids: number[] = [];
	for (const text of pages) {
		const stream = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
		const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
		kids.push(
			add(
				`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
			),
		);
	}
	objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
	objects[pagesObj - 1] =
		`<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
	let pdf = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, index) => {
		offsets.push(Buffer.byteLength(pdf, "latin1"));
		pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = Buffer.byteLength(pdf, "latin1");
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	writeFileSync(path, pdf, "latin1");
	return path;
}
