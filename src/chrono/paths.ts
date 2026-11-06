import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { comparePageOrder, pyLen, pyRstrip, pySlice, pyStem, pySuffix } from "./py.ts";

/**
 * Where ChronoTranscriber and ChronoMiner write an item, ported from CT `output/paths.py` and `run.py`
 * (`item_location`) and CM `discovery.py` (`item_paths`) and `output/store.py` (`document_name`). Lengths are counted
 * in code points, as Python counts them; paths are the real paths Python's `Path.resolve()` gives.
 */

const WINDOWS_MAX_PATH = 260;
const MAX_SAFE_NAME_LENGTH = 80;
const HASH_LENGTH = 8;
const MIN_READABLE_LENGTH = 20;

/** `Path.resolve()`: the real path of the existing part, the rest as given. */
export function realPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync.native(absolute);
	} catch {
		const parent = dirname(absolute);
		return parent === absolute ? absolute : join(realPath(parent), basename(absolute));
	}
}

function nameHash(name: string): string {
	return createHash("sha256").update(name, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

function truncateName(name: string, maxLength: number): string {
	if (pyLen(name) <= maxLength) return name;
	return pyRstrip(pySlice(name, maxLength), ".-_ ");
}

export function createSafeDirectoryName(original: string, suffix = ""): string {
	const available = MAX_SAFE_NAME_LENGTH - (pyLen(suffix) + HASH_LENGTH + 1);
	return `${truncateName(original, available)}-${nameHash(original)}${suffix}`;
}

export function createSafeFilename(original: string, extension: string, parent?: string): string {
	let maxLength = MAX_SAFE_NAME_LENGTH;
	if (parent !== undefined) {
		const parentLength = pyLen(parent) + 1;
		const limit = WINDOWS_MAX_PATH - parentLength - 10;
		maxLength = Math.max(
			MIN_READABLE_LENGTH + HASH_LENGTH + pyLen(extension) + 1,
			Math.min(limit, MAX_SAFE_NAME_LENGTH),
		);
	}
	const available = maxLength - (pyLen(extension) + HASH_LENGTH + 1);
	if (pyLen(original) > available) {
		return `${truncateName(original, Math.max(MIN_READABLE_LENGTH, available))}-${nameHash(original)}${extension}`;
	}
	return `${original}${extension}`;
}

/** `item.relative_to(root)` as a native path, or undefined when `item` is not below `root`. */
function relativeTo(item: string, root: string): string | undefined {
	const rel = relative(root, item);
	if (rel === "") return ".";
	if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel;
}

/** A path without its last suffix (`Path.with_suffix("")`). */
function withoutSuffix(path: string): string {
	const suffix = pySuffix(basename(path));
	return suffix ? path.slice(0, path.length - suffix.length) : path;
}

/** `document_name`: the output path relative to the root without its suffix (posix), else the file name. */
function nameBelow(base: string, root: string): string {
	const rel = relativeTo(base, root);
	return rel === undefined || rel === "." ? basename(base) : rel.split(sep).join("/");
}

export type TranscriptionLayout = "hash" | "mirror";
export type ExtractionLayout = "flat" | "mirror";

export interface CtLocation {
	/** The output root: the folder of chronotranscriber.sqlite. */
	root: string;
	/** The store document's name. */
	name: string;
	/** The rendered file of the first text format. */
	output: string;
}

/**
 * ChronoTranscriber's `item_location` for a PDF or image folder `item` (real paths). `inputRoot` is the input the
 * item was found in; `outputDir` undefined writes beside the input.
 */
export function ctLocation(
	item: string,
	isFolder: boolean,
	options: { outputDir?: string; layout: TranscriptionLayout; inputRoot: string; firstFormat: string },
): CtLocation {
	const name = basename(item);
	const stem = isFolder ? name : pyStem(name);
	const { outputDir, inputRoot } = options;
	let output: string;
	if (outputDir === undefined) {
		output = join(dirname(item), createSafeFilename(stem, ".txt", dirname(item)));
	} else if (options.layout === "mirror") {
		const anchor = isFolder ? item : dirname(item);
		const rel = relativeTo(anchor, inputRoot) ?? basename(anchor);
		const folder = rel === "." ? outputDir : join(outputDir, rel);
		output = join(folder, createSafeFilename(stem, `.${options.firstFormat}`, folder));
	} else {
		const rel = relativeTo(item, inputRoot);
		const key = rel === undefined || rel === "." ? stem : rel;
		const folder = join(outputDir, createSafeDirectoryName(key));
		output = join(folder, createSafeFilename(stem, ".txt", folder));
	}
	const root = outputDir ?? dirname(item);
	return { root, name: nameBelow(withoutSuffix(output), root), output };
}

/** The rendered file of a text format beside the first one (`format_path`). */
export function ctFormatPath(output: string, format: string): string {
	return `${withoutSuffix(output)}.${format}`;
}

export interface CmLocation {
	root: string;
	name: string;
	/** `<stem>_output.json`. */
	output: string;
}

export const CM_OUTPUT_SUFFIX = "_output.json";

/** ChronoMiner's location of an input file `item` (real paths): `<folder>/<stem>_output.json`. */
export function cmLocation(
	item: string,
	options: { outputDir?: string; layout: ExtractionLayout; inputRoot: string },
): CmLocation {
	const { outputDir, inputRoot } = options;
	let folder: string;
	if (outputDir === undefined) {
		folder = dirname(item);
	} else if (options.layout === "mirror") {
		let root = inputRoot;
		try {
			if (!statSync(inputRoot).isDirectory()) root = dirname(inputRoot);
		} catch {
			root = dirname(inputRoot);
		}
		const rel = relativeTo(dirname(item), root);
		folder = rel === undefined || rel === "." ? outputDir : join(outputDir, rel);
	} else {
		folder = outputDir;
	}
	const output = join(folder, `${pyStem(basename(item))}${CM_OUTPUT_SUFFIX}`);
	const root = outputDir ?? dirname(item);
	const base = output.slice(0, output.length - CM_OUTPUT_SUFFIX.length);
	return { root, name: nameBelow(base, root), output };
}

/** The CSV beside an `_output.json` (`output.with_suffix(".csv")`). */
export function cmCsvPath(output: string): string {
	return `${withoutSuffix(output)}.csv`;
}

/** ChronoTranscriber's supported page images (`llm/media.py`). */
export const CT_IMAGE_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".tiff",
	".tif",
	".bmp",
	".gif",
	".webp",
	".jp2",
	".j2k",
	".pbm",
	".pgm",
	".ppm",
]);

/**
 * `list_folder_images`: the supported images directly in `folder` (hidden files included), in page order (natural
 * order, ties broken by the file name).
 */
export function listFolderImages(folder: string): string[] {
	const names = readdirSync(folder).filter((name) => {
		if (!CT_IMAGE_EXTENSIONS.has(pySuffix(name).toLowerCase())) return false;
		try {
			return statSync(join(folder, name)).isFile();
		} catch {
			return false;
		}
	});
	return names.sort(comparePageOrder).map((name) => join(folder, name));
}

/** Lower-cased extension as Node reports it (for the readers Mabillon has). */
export function lowerExt(path: string): string {
	return extname(path).toLowerCase();
}
