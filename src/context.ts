import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ChronoConfig } from "./config.ts";
import { IMAGE_EXTENSIONS, type SourceDocument } from "./inputs/discover.ts";
import { decodeText, naturalCompare } from "./util.ts";

export interface ContextBundle {
	texts: Array<{ path: string; content: string }>;
	images: string[];
}

const TEXT_CONTEXT_EXTENSIONS = new Set([".md", ".txt", ".markdown"]);

function filesMatching(dir: string, prefix: string): string[] {
	if (!existsSync(dir)) return [];
	const lowerPrefix = prefix.toLowerCase();
	return readdirSync(dir)
		.filter((name) => {
			const lower = name.toLowerCase();
			if (!lower.startsWith(lowerPrefix)) return false;
			const rest = lower.slice(lowerPrefix.length);
			// "context.md", "context-2.png", "context_hand.jpg" but not "contextual.md"
			return rest.startsWith(".") || rest.startsWith("-") || rest.startsWith("_") || /^\d/.test(rest);
		})
		.sort(naturalCompare)
		.map((name) => join(dir, name))
		.filter((path) => statSync(path).isFile());
}

function collect(candidates: string[], bundle: ContextBundle, seen: Set<string>): void {
	for (const path of candidates) {
		if (seen.has(path)) continue;
		const ext = extname(path).toLowerCase();
		if (TEXT_CONTEXT_EXTENSIONS.has(ext)) {
			seen.add(path);
			const content = decodeText(readFileSync(path)).text.trim();
			if (content) bundle.texts.push({ path, content });
		} else if (IMAGE_EXTENSIONS.has(ext)) {
			seen.add(path);
			bundle.images.push(path);
		}
	}
}

/** Explicit context files must exist and be of a supported kind (checked before any work starts). */
export function checkContextFiles(config: ChronoConfig): void {
	for (const path of config.context) {
		if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Context file not found: ${path}`);
		const ext = extname(path).toLowerCase();
		if (IMAGE_EXTENSIONS.has(ext)) throw new Error(`${path} is an image; pass it with --context-image`);
		if (!TEXT_CONTEXT_EXTENSIONS.has(ext)) {
			throw new Error(`Context file ${path}: only .md, .markdown and .txt files are supported as context text`);
		}
	}
	for (const path of config.contextImages) {
		if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Context image not found: ${path}`);
		if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) {
			throw new Error(`Context image ${path}: unsupported image type`);
		}
	}
}

/**
 * Gather context for one document, general to specific:
 * 1. --context / --context-image files from the command line or config,
 * 2. context.* in the folder containing the document,
 * 3. for image folders, context.* inside the folder,
 * 4. <stem>.context.* next to the document.
 */
export function resolveContext(doc: SourceDocument, config: ChronoConfig): ContextBundle {
	const bundle: ContextBundle = { texts: [], images: [] };
	const seen = new Set<string>();
	checkContextFiles(config);
	collect(config.context, bundle, seen);
	for (const path of config.contextImages) {
		if (!seen.has(path)) {
			seen.add(path);
			bundle.images.push(path);
		}
	}
	if (!config.autoContext) return bundle;

	const isFolder = doc.kind === "images" && statSync(doc.path).isDirectory();
	const parent = dirname(doc.path);
	const stem = isFolder ? basename(doc.path) : basename(doc.path, extname(doc.path));
	collect(filesMatching(parent, "context"), bundle, seen);
	if (isFolder) collect(filesMatching(doc.path, "context"), bundle, seen);
	collect(filesMatching(parent, `${stem}.context`), bundle, seen);
	return bundle;
}
