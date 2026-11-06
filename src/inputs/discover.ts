import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { listFolderImages } from "../chrono/paths.ts";
import type { Mode } from "../config.ts";
import { canonicalPath, naturalCompare, safeStem } from "../util.ts";

/** Page images Mabillon decodes (sharp); a folder's other images (BMP, JPEG 2000, PNM) are left out of its pages. */
export const READABLE_PAGE_IMAGES = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".gif"]);

export type SourceKind = "pdf" | "images" | "text";

export interface SourceDocument {
	/** Identifier used for the output folder and file names. */
	stem: string;
	kind: SourceKind;
	/** The PDF, text file, image file, or image folder. */
	path: string;
	/** Page images in order (image documents only). */
	images?: string[];
	/** The input (command-line path) the document was found in; the hash and mirror layouts name outputs by it. */
	inputRoot?: string;
	/** Why the document cannot be processed (reported as its error before any work). */
	refusal?: string;
}

const MAX_DEPTH = 8;

/** Default output folder name; skipped when scanning input folders. */
export const OUTPUT_DIR_NAME = "chronoagent_output";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"]);
export const TEXT_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".csv",
	".tsv",
	".json",
	".jsonl",
	".xml",
	".tei",
	".yaml",
	".yml",
	".html",
	".htm",
	".xhtml",
	".docx",
	".epub",
]);

export function isImageFile(path: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isTextFile(path: string): boolean {
	return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function isSupported(path: string): boolean {
	const ext = extname(path).toLowerCase();
	return ext === ".pdf" || IMAGE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
}

const CONTEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ...IMAGE_EXTENSIONS]);

/** Context files (context.md, context-1.png, <stem>.context.md, ...) are never treated as documents. */
export function isContextFile(path: string): boolean {
	const name = basename(path).toLowerCase();
	if (!CONTEXT_EXTENSIONS.has(extname(name))) return false;
	return /^context([._\-\d]|$)/.test(name) || /\.context([._\-\d]|$)/.test(name);
}

/** ChronoMiner line-range files belong to a text document; they are not documents themselves. */
function isLineRangesFile(path: string): boolean {
	return /_line_ranges\.txt$/i.test(basename(path));
}

/**
 * Files Mabillon, ChronoTranscriber and ChronoMiner write or read beside an input: the stores and their journals,
 * the ChronoMiner outputs, the Mabillon sidecars and the tools' context sidecars. They are never documents.
 */
export function isToolFile(path: string): boolean {
	const name = basename(path).toLowerCase();
	if (/^(chronotranscriber|chronominer)\.sqlite(-.*)?$/.test(name)) return true;
	if (name.endsWith(".mabillon.json") || name.endsWith("_output.json") || name.endsWith("_output.csv")) return true;
	return /_(extract|adjust|transcr)_context(_image)?\.[^.]+$/.test(name);
}

type EntryKind = "file" | "dir" | "broken";

function entryKind(path: string): EntryKind {
	try {
		const stats = statSync(path);
		return stats.isDirectory() ? "dir" : stats.isFile() ? "file" : "broken";
	} catch {
		return "broken";
	}
}

function listDir(dir: string): string[] {
	return readdirSync(dir)
		.filter((name) => !name.startsWith("."))
		.sort(naturalCompare)
		.map((name) => join(dir, name));
}

/**
 * Base stem of a file document. When the same folder holds another supported file or a folder with the same base
 * name (book.pdf and book.txt, or book.pdf and book/), the extension is appended (book_pdf), so the name does not
 * depend on which inputs a run happens to include.
 */
function fileStem(path: string): string {
	const ext = extname(path);
	const base = basename(path, ext);
	const lower = base.toLowerCase();
	let siblings: string[] = [];
	try {
		siblings = readdirSync(dirname(path)).filter((name) => name !== basename(path));
	} catch {
		// unreadable folder: no collision handling possible
	}
	const collides = siblings.some((name) => {
		const siblingExt = extname(name);
		const siblingPath = join(dirname(path), name);
		if (basename(name, siblingExt).toLowerCase() !== lower) {
			return name.toLowerCase() === lower && entryKind(siblingPath) === "dir";
		}
		return isSupported(siblingPath) && !isContextFile(siblingPath);
	});
	return safeStem(collides ? `${base}_${ext.slice(1).toLowerCase()}` : base);
}

export interface DiscoveryResult {
	documents: SourceDocument[];
	skipped: Array<{ path: string; reason: string }>;
}

/**
 * Resolve CLI inputs into documents.
 * - A PDF or text file is one document; a single image file is a one-page document.
 * - A folder that directly contains images is one image document (pages in natural order); its PDFs and text files
 *   are separate documents. Subfolders are searched the same way (up to eight levels; hidden folders, ChronoAgent
 *   output folders, and the `exclude` folders such as a custom --out are skipped).
 * Transcription accepts PDFs and images only; extraction accepts all three kinds.
 */
/** A ChronoAgent output folder: a document folder (run/state.json) or a root holding such folders. */
function isOutputFolder(dir: string): boolean {
	return basename(dir) === OUTPUT_DIR_NAME || existsSync(join(dir, "run", "state.json"));
}

export function discoverDocuments(inputs: string[], mode: Mode, exclude: string[] = []): DiscoveryResult {
	const excluded = new Set(
		exclude.map((path) => {
			try {
				return realpathSync(resolve(path));
			} catch {
				return resolve(path);
			}
		}),
	);
	const documents: SourceDocument[] = [];
	const skipped: Array<{ path: string; reason: string }> = [];
	const seen = new Set<string>();

	let inputRoot = "";
	const add = (doc: SourceDocument) => {
		// The same file reached through another spelling (case, drive letter case, symlink) is one document.
		const key = canonicalPath(doc.path);
		if (seen.has(key)) return;
		seen.add(key);
		documents.push({ ...doc, inputRoot });
	};

	const addFile = (path: string, explicit: boolean) => {
		if (isContextFile(path) || isLineRangesFile(path) || isToolFile(path)) {
			if (explicit) {
				skipped.push({
					path,
					reason: isLineRangesFile(path)
						? "ChronoMiner line-ranges files are read with their text document, not processed on their own"
						: isToolFile(path)
							? "a store, output, sidecar or context file of Mabillon, ChronoTranscriber or ChronoMiner"
							: "named like a context file (context*, *.context*); rename it to process it as a document",
				});
			}
			return;
		}
		const ext = extname(path).toLowerCase();
		if (ext === ".pdf") {
			add({ stem: fileStem(path), kind: "pdf", path });
		} else if (IMAGE_EXTENSIONS.has(ext)) {
			add({ stem: fileStem(path), kind: "images", path, images: [path] });
		} else if (TEXT_EXTENSIONS.has(ext)) {
			if (mode === "transcribe") {
				skipped.push({ path, reason: "text documents can only be used in extraction mode" });
			} else {
				add({ stem: fileStem(path), kind: "text", path });
			}
		} else if (explicit || ext !== "") {
			skipped.push({ path, reason: `unsupported file type "${ext || "(none)"}"` });
		}
	};

	const addImageFolder = (dir: string, images: string[]) => {
		// The pages are ChronoTranscriber's page list of the folder (hidden and context-named images included); a page
		// Mabillon cannot decode refuses the document rather than leaving the page out.
		const unreadable = images.filter((image) => !READABLE_PAGE_IMAGES.has(extname(image).toLowerCase()));
		const refusal =
			unreadable.length > 0
				? `${unreadable.map((image) => basename(image)).join(", ")} ${unreadable.length === 1 ? "is a page" : "are pages"} of the folder in ChronoTranscriber's page list that Mabillon cannot decode; convert ${unreadable.length === 1 ? "it" : "them"} to PNG or JPEG`
				: undefined;
		add({ stem: safeStem(basename(dir)), kind: "images", path: dir, images, ...(refusal ? { refusal } : {}) });
	};

	const visited = new Set<string>();
	/** A folder of page images is one document; its PDFs and text files and everything in subfolders are separate. */
	const walk = (dir: string, depth: number) => {
		let real: string;
		try {
			real = realpathSync(dir);
		} catch {
			real = dir;
		}
		if (visited.has(real) || excluded.has(real)) return;
		visited.add(real);
		let entries: string[];
		try {
			entries = listDir(dir);
		} catch {
			skipped.push({ path: dir, reason: "folder cannot be read" });
			return;
		}
		// A folder is an image document when ChronoTranscriber's page list has an image that is not named as context
		// (context.png beside a PDF stays context); all images of the list are then its pages.
		const listed = listFolderImages(dir);
		const directImages = listed.some((image) => !isContextFile(image)) ? listed : [];
		if (directImages.length > 0) addImageFolder(dir, directImages);
		const pages = new Set(directImages.map((image) => basename(image)));
		for (const entry of entries) {
			const entryType = entryKind(entry);
			if (entryType === "broken") {
				skipped.push({ path: entry, reason: "broken link or unreadable entry" });
			} else if (entryType === "file") {
				if (pages.has(basename(entry))) continue;
				addFile(entry, false);
			} else if (!isOutputFolder(entry)) {
				if (depth >= MAX_DEPTH) skipped.push({ path: entry, reason: `deeper than ${MAX_DEPTH} folder levels` });
				else walk(entry, depth + 1);
			}
		}
	};

	for (const input of inputs) {
		const path = resolve(input);
		inputRoot = path;
		const kind = entryKind(path);
		if (kind === "broken") {
			skipped.push({ path, reason: "does not exist or cannot be read" });
			continue;
		}
		if (kind === "file") {
			addFile(path, true);
			continue;
		}
		walk(path, 0);
	}
	return { documents, skipped };
}

/**
 * Make stems unique within each output folder: colliding documents from different folders get their parent
 * folder's name as a prefix. Each remaining name goes to the first document in path order; the others get the
 * lowest numeric suffix (_2, _3, ...) that no document of the same output folder uses. Comparison ignores case
 * (macOS, Windows).
 */
export function assignStems(documents: SourceDocument[], outputRoot: (doc: SourceDocument) => string): void {
	const groups = new Map<string, SourceDocument[]>();
	for (const doc of documents) {
		const key = `${outputRoot(doc)}\u0000${doc.stem.toLowerCase()}`;
		groups.set(key, [...(groups.get(key) ?? []), doc]);
	}
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		for (const doc of group) doc.stem = safeStem(`${basename(dirname(doc.path))}_${doc.stem}`);
	}
	const taken = new Set<string>();
	const key = (doc: SourceDocument, stem: string) => `${outputRoot(doc)}\u0000${stem.toLowerCase()}`;
	const ordered = [...documents].sort((a, b) => naturalCompare(a.path, b.path));
	const renamed: SourceDocument[] = [];
	for (const doc of ordered) {
		if (taken.has(key(doc, doc.stem))) renamed.push(doc);
		else taken.add(key(doc, doc.stem));
	}
	for (const doc of renamed) {
		let suffix = 2;
		while (taken.has(key(doc, `${doc.stem}_${suffix}`))) suffix++;
		doc.stem = `${doc.stem}_${suffix}`;
		taken.add(key(doc, doc.stem));
	}
}
