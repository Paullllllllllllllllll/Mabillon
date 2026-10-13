import sharp from "sharp";

export const ENHANCEMENTS = ["grayscale", "contrast", "sharpen", "threshold", "invert"] as const;
export type Enhancement = (typeof ENHANCEMENTS)[number];

/** Normalized region of a page: x/y of the top-left corner, w/h as fractions of page width/height. */
export interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Size limits of a model's image input (see image-profile.ts). */
export interface ImageLimits {
	maxEdge: number;
	maxPixels: number;
	maxBytes: number;
	/** Patch-based budgets (OpenAI): ceil(w / patchSize) * ceil(h / patchSize) <= maxPatches. */
	patchSize?: number;
	maxPatches?: number;
	/**
	 * Tokens the processor adds to the patches, counted against maxPatches: per row of patches (row separators) and
	 * per image (begin and end markers). DeepSeek: rows * (columns + 1) + 2.
	 */
	rowTokens?: number;
	imageTokens?: number;
	/**
	 * Token grid of the model's image processor (open-weight models). The image is padded with white to a multiple of
	 * it, so that the host's processor, which rounds sizes to its grid, does not resample the image.
	 */
	align?: number;
}

export interface ViewOptions {
	box?: Box;
	/** Extra magnification for a region (0.25-8). Default: small regions are enlarged up to 3x. */
	scale?: number;
	/** Clockwise rotation in degrees, applied after cropping. */
	rotate?: number;
	enhance?: Enhancement[];
	/** Overlay a labelled grid in page coordinates. */
	grid?: boolean;
	limits: ImageLimits;
}

export interface PreparedImage {
	data: string;
	mimeType: "image/jpeg";
	width: number;
	height: number;
	/** Size of the image content before white padding to the model's token grid (equal to width/height if none). */
	contentWidth: number;
	contentHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	/** The page region (normalized) that the image shows. */
	region: Box;
	/** Pixel size of that region in the source image. */
	regionPixels: { width: number; height: number };
}

/** Decoded pixels, kept uncompressed so that every view is encoded exactly once. */
export interface RawImage {
	data: Buffer;
	width: number;
	height: number;
	channels: 1 | 2 | 3 | 4;
}

export type ImageLoader = () => Promise<RawImage>;

const RAW_CACHE = new Map<string, Promise<RawImage>>();
const RAW_CACHE_SIZE = 3;
/** Our own raw buffers are bounded; no decoder limit needed. */
const SHARP_OPTIONS = { limitInputPixels: false } as const;
/** Image files larger than this are refused (decompression bombs). */
export const MAX_INPUT_PIXELS = 1_000_000_000;
/** Image files are decoded at most at this size (about 10,000 x 10,000 px); larger scans are reduced on load. */
export const MAX_DECODED_PIXELS = 100_000_000;

function rawInput(image: RawImage) {
	return { ...SHARP_OPTIONS, raw: { width: image.width, height: image.height, channels: image.channels } };
}

async function toRaw(pipeline: ReturnType<typeof sharp>): Promise<RawImage> {
	const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height, channels: info.channels as RawImage["channels"] };
}

/** Loader for an image file or buffer (optionally one page of a multi-page TIFF), EXIF-oriented, flattened to RGB. */
export function fileLoader(path: string | Buffer, page?: number): ImageLoader {
	return async () => {
		const options = { limitInputPixels: MAX_INPUT_PIXELS, page: page ?? 0 };
		const { width = 0, height = 0, orientation = 1 } = await sharp(path, options).metadata();
		let pipeline = sharp(path, options).rotate();
		if (width * height > MAX_DECODED_PIXELS) {
			const factor = Math.sqrt(MAX_DECODED_PIXELS / (width * height));
			// The resize applies after the EXIF rotation, which swaps the sides for orientations 5-8.
			const [w, h] = orientation >= 5 ? [height, width] : [width, height];
			pipeline = pipeline.resize({
				width: Math.max(1, Math.floor(w * factor)),
				height: Math.max(1, Math.floor(h * factor)),
				fit: "inside",
			});
		}
		return toRaw(pipeline.flatten({ background: "#ffffff" }).toColourspace("srgb"));
	};
}

/** Decode once and cache by key (file path or PDF page). */
export function loadRaw(key: string, loader: ImageLoader): Promise<RawImage> {
	let entry = RAW_CACHE.get(key);
	if (entry) {
		// Refresh recency.
		RAW_CACHE.delete(key);
		RAW_CACHE.set(key, entry);
		return entry;
	}
	entry = loader();
	RAW_CACHE.set(key, entry);
	while (RAW_CACHE.size > RAW_CACHE_SIZE) {
		const oldest = RAW_CACHE.keys().next().value;
		if (oldest === undefined) break;
		RAW_CACHE.delete(oldest);
	}
	entry.catch(() => RAW_CACHE.delete(key));
	return entry;
}

export function clearImageCache(): void {
	RAW_CACHE.clear();
}

function clampBox(box: Box): Box {
	const x = Math.min(Math.max(box.x, 0), 0.999);
	const y = Math.min(Math.max(box.y, 0), 0.999);
	const w = Math.min(Math.max(box.w, 0.001), 1 - x);
	const h = Math.min(Math.max(box.h, 0.001), 1 - y);
	return { x, y, w, h };
}

/**
 * Decimals for grid labels of a region of size `size`: enough that labels one tenth of the region apart never
 * round to the same text (two at least, six at most).
 */
export function gridDecimals(size: number): number {
	const step = Math.max(size, 1e-6) / 10;
	return Math.min(6, Math.max(2, Math.ceil(-Math.log10(step * 0.9))));
}

/** Labels of the nine grid lines across a region starting at `start` with size `size` (page fractions). */
export function gridLabels(start: number, size: number): string[] {
	const decimals = gridDecimals(size);
	return Array.from({ length: 9 }, (_, i) => (start + (size * (i + 1)) / 10).toFixed(decimals));
}

function gridSvg(width: number, height: number, region: Box): Buffer {
	const lines: string[] = [];
	const fontSize = Math.max(12, Math.round(Math.min(width, height) / 45));
	const labelsX = gridLabels(region.x, region.w);
	const labelsY = gridLabels(region.y, region.h);
	for (let i = 1; i < 10; i++) {
		const px = Math.round((width * i) / 10);
		const py = Math.round((height * i) / 10);
		const labelX = labelsX[i - 1];
		const labelY = labelsY[i - 1];
		lines.push(
			`<line x1="${px}" y1="0" x2="${px}" y2="${height}" stroke="#ff0066" stroke-opacity="0.55" stroke-width="1"/>`,
		);
		lines.push(
			`<line x1="0" y1="${py}" x2="${width}" y2="${py}" stroke="#ff0066" stroke-opacity="0.55" stroke-width="1"/>`,
		);
		lines.push(
			`<text x="${px + 3}" y="${fontSize + 2}" font-family="sans-serif" font-size="${fontSize}" fill="#ff0066">${labelX}</text>`,
		);
		lines.push(
			`<text x="3" y="${py - 3}" font-family="sans-serif" font-size="${fontSize}" fill="#ff0066">${labelY}</text>`,
		);
	}
	return Buffer.from(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines.join("")}</svg>`,
	);
}

/** Largest scale factor (<= wanted) for which a w x h image fits every limit, including after rotation. */
export function fitFactor(width: number, height: number, wanted: number, limits: ImageLimits, rotate = 0): number {
	const radians = ((rotate % 360) * Math.PI) / 180;
	const cos = Math.abs(Math.cos(radians));
	const sin = Math.abs(Math.sin(radians));
	const outWidth = width * cos + height * sin;
	const outHeight = width * sin + height * cos;
	let factor = Math.min(
		wanted,
		limits.maxEdge / Math.max(outWidth, outHeight),
		Math.sqrt(limits.maxPixels / (outWidth * outHeight)),
	);
	const { patchSize, maxPatches, align, rowTokens = 0, imageTokens = 0 } = limits;
	// With an alignment, the padded size has to fit as well.
	const padded = (size: number) => (align ? Math.ceil(size / align - 1e-9) * align : size);
	const fits = (f: number) => {
		const w = padded(outWidth * f);
		const h = padded(outHeight * f);
		// Tolerances: the initial factor meets the edge and pixel limits up to rounding.
		if (Math.max(w, h) > limits.maxEdge * (1 + 1e-9) || w * h > limits.maxPixels * (1 + 1e-9)) return false;
		if (!(patchSize && maxPatches)) return true;
		const rows = Math.ceil(h / patchSize);
		return rows * (Math.ceil(w / patchSize) + rowTokens) + imageTokens <= maxPatches;
	};
	while (factor > 0.01 && !fits(factor)) factor *= 0.99;
	return factor;
}

/** White padding at the right and bottom up to a multiple of `align` (see ImageLimits.align). */
export async function padToGrid(image: RawImage, align: number | undefined): Promise<RawImage> {
	if (!align || align <= 1) return image;
	const right = (align - (image.width % align)) % align;
	const bottom = (align - (image.height % align)) % align;
	if (right === 0 && bottom === 0) return image;
	return toRaw(sharp(image.data, rawInput(image)).extend({ right, bottom, background: "#ffffff" }));
}

/**
 * Crop, enhance, resize, and grid a page image for the model. All intermediate steps are lossless; the result is
 * JPEG-encoded once, at the highest quality that fits the byte limit.
 */
export async function prepareImage(
	key: string,
	source: ImageLoader | string | Buffer,
	options: ViewOptions,
): Promise<PreparedImage> {
	const loader = typeof source === "function" ? source : fileLoader(source);
	const page = await loadRaw(key, loader);
	const region = options.box ? clampBox(options.box) : { x: 0, y: 0, w: 1, h: 1 };
	const left = Math.min(Math.round(region.x * page.width), page.width - 1);
	const top = Math.min(Math.round(region.y * page.height), page.height - 1);
	const width = Math.max(1, Math.min(Math.round(region.w * page.width), page.width - left));
	const height = Math.max(1, Math.min(Math.round(region.h * page.height), page.height - top));

	let image = page;
	if (options.box) image = await toRaw(sharp(page.data, rawInput(page)).extract({ left, top, width, height }));

	// Enhancements apply in the order given (repeats once). sharp runs the operations of one pipeline in its own
	// fixed order, so each step gets its own pipeline.
	for (const step of new Set(options.enhance ?? [])) {
		let pipeline = sharp(image.data, rawInput(image));
		if (step === "grayscale") pipeline = pipeline.grayscale();
		else if (step === "contrast") pipeline = pipeline.normalise();
		else if (step === "sharpen") pipeline = pipeline.sharpen();
		else if (step === "threshold") pipeline = pipeline.grayscale().threshold(140);
		else if (step === "invert") pipeline = pipeline.negate({ alpha: false });
		image = await toRaw(pipeline.toColourspace("srgb"));
	}

	const longEdge = Math.max(image.width, image.height);
	// Full pages are never enlarged; small regions are enlarged (up to 3x, or `scale`) so fine print stays legible.
	const wanted = options.box ? (options.scale ?? (longEdge < 1000 ? Math.min(3, 1000 / longEdge) : 1)) : 1;
	let factor = fitFactor(
		image.width,
		image.height,
		Math.min(Math.max(wanted, 0.05), 8),
		options.limits,
		options.rotate,
	);

	let final: { data: Buffer; info: { width: number; height: number } } | undefined;
	let content = { width: 0, height: 0 };
	for (let attempt = 0; attempt < 8 && !final; attempt++) {
		// Floor (with a small epsilon for exact factors) so the result never exceeds the limits.
		const targetWidth = Math.max(1, Math.floor(image.width * factor + 1e-9));
		const targetHeight = Math.max(1, Math.floor(image.height * factor + 1e-9));
		let sized =
			targetWidth === image.width && targetHeight === image.height
				? image
				: await toRaw(
						sharp(image.data, rawInput(image)).resize({
							width: targetWidth,
							height: targetHeight,
							fit: "fill",
							kernel: "lanczos3",
						}),
					);
		if (options.grid) {
			sized = await toRaw(
				sharp(sized.data, rawInput(sized)).composite([
					{ input: gridSvg(sized.width, sized.height, region), top: 0, left: 0 },
				]),
			);
		}
		let pipeline = sharp(sized.data, rawInput(sized));
		if (options.rotate && options.rotate % 360 !== 0) {
			pipeline = pipeline.rotate(options.rotate, { background: "#ffffff" });
		}
		const unpadded = await toRaw(pipeline);
		content = { width: unpadded.width, height: unpadded.height };
		const oriented = await padToGrid(unpadded, options.limits.align);
		for (const quality of [90, 82, 74]) {
			const candidate = await sharp(oriented.data, rawInput(oriented))
				.jpeg({ quality, chromaSubsampling: quality >= 90 ? "4:4:4" : "4:2:0" })
				.toBuffer({ resolveWithObject: true });
			if (Math.ceil(candidate.data.length / 3) * 4 <= options.limits.maxBytes) {
				final = candidate;
				break;
			}
		}
		factor *= 0.85;
	}
	if (!final) throw new Error("Image could not be reduced below the provider's size limit");
	return {
		data: final.data.toString("base64"),
		mimeType: "image/jpeg",
		width: final.info.width,
		height: final.info.height,
		contentWidth: content.width,
		contentHeight: content.height,
		sourceWidth: page.width,
		sourceHeight: page.height,
		region,
		regionPixels: { width, height },
	};
}

/** Load a context image (any supported format) as a model-ready JPEG. */
export async function prepareContextImage(path: string, limits: ImageLimits): Promise<PreparedImage> {
	return prepareImage(`context:${path}`, fileLoader(path), { limits });
}

/** `zoomHint`: mention zooming with `box` (only when the agent has the view tool). */
export function describePrepared(label: string, image: PreparedImage, zoomHint = true): string {
	const r = image.region;
	const full = r.x === 0 && r.y === 0 && r.w === 1 && r.h === 1;
	const where = full
		? "full page"
		: `region x=${r.x.toFixed(3)}..${(r.x + r.w).toFixed(3)}, y=${r.y.toFixed(3)}..${(r.y + r.h).toFixed(3)}`;
	const scale =
		Math.max(image.contentWidth, image.contentHeight) /
		Math.max(1, image.regionPixels.width, image.regionPixels.height);
	const note =
		scale < 0.95
			? ` Downscaled to ${Math.round(scale * 100)}% for the model${zoomHint ? "; zoom in with box to read fine detail" : ""}.`
			: "";
	const padded =
		image.contentWidth !== image.width || image.contentHeight !== image.height
			? ` (padded with white at the right and bottom to ${image.width}x${image.height} px; the padding is not part of the page)`
			: "";
	return `${label}: ${where}; source ${image.sourceWidth}x${image.sourceHeight} px (region ${image.regionPixels.width}x${image.regionPixels.height} px), shown at ${image.contentWidth}x${image.contentHeight} px${padded}.${note}`;
}
