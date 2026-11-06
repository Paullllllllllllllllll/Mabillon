import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { pyStem } from "./chrono/py.ts";
import type { ChronoConfig, Mode } from "./config.ts";
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

/** The first existing candidate (ChronoTranscriber and ChronoMiner try their sidecar tiers in this order). */
function firstFile(candidates: string[], usable: (path: string) => boolean = () => true): string | undefined {
	return candidates.find((path) => {
		try {
			return statSync(path).isFile() && usable(path);
		} catch {
			return false;
		}
	});
}

/** ChronoTranscriber's context image extensions, in its lookup order (sorted). */
const CT_CONTEXT_IMAGES = [
	".bmp",
	".gif",
	".j2k",
	".jp2",
	".jpeg",
	".jpg",
	".pbm",
	".pgm",
	".png",
	".ppm",
	".tif",
	".tiff",
	".webp",
];
/** ChronoMiner's context image extensions, in its lookup order. */
const CM_CONTEXT_IMAGES = [".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".gif", ".webp"];

/**
 * The context sidecars of ChronoTranscriber (`{name}_transcr_context.txt`, `{name}_transcr_context_image.*`) or
 * ChronoMiner (`{stem}_extract_context.txt|png|...`): beside the input, else (ChronoTranscriber: for files only)
 * beside its folder (`{folder}_..._context.*`). Text sidecars that are empty fall through, as in the tools.
 */
function toolSidecars(doc: SourceDocument, mode: Mode, isFolder: boolean): { text?: string; image?: string } {
	const name = isFolder ? basename(doc.path) : pyStem(basename(doc.path));
	const parent = dirname(doc.path);
	const folderTier = !isFolder || mode === "extract";
	const suffix = mode === "transcribe" ? "_transcr_context" : "_extract_context";
	const imageSuffix = mode === "transcribe" ? "_transcr_context_image" : "_extract_context";
	const tiers = [
		join(parent, name),
		...(folderTier && dirname(parent) !== parent ? [join(dirname(parent), basename(parent))] : []),
	];
	const nonEmpty = (path: string) => decodeText(readFileSync(path)).text.trim() !== "";
	const text = firstFile(
		tiers.map((base) => `${base}${suffix}.txt`),
		nonEmpty,
	);
	const extensions = mode === "transcribe" ? CT_CONTEXT_IMAGES : CM_CONTEXT_IMAGES;
	const image = firstFile(tiers.flatMap((base) => extensions.map((ext) => `${base}${imageSuffix}${ext}`)));
	return { text, image: image && IMAGE_EXTENSIONS.has(extname(image).toLowerCase()) ? image : undefined };
}

/**
 * Gather context for one document, general to specific:
 * 1. --context / --context-image files from the command line or config,
 * 2. context.* in the folder containing the document,
 * 3. <stem>.context.* next to the document,
 * 4. the context sidecar of ChronoTranscriber (transcription) or ChronoMiner (extraction) of the document.
 * Images inside an image folder are its pages, whatever their names.
 */
export function resolveContext(doc: SourceDocument, config: ChronoConfig, mode: Mode = "transcribe"): ContextBundle {
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
	collect(filesMatching(parent, `${stem}.context`), bundle, seen);
	const sidecars = toolSidecars(doc, mode, isFolder);
	collect(
		[sidecars.text, sidecars.image].filter((path): path is string => path !== undefined),
		bundle,
		seen,
	);
	return bundle;
}
