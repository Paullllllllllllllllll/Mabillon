import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RawImage } from "./images.ts";

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve("pdfjs-dist/package.json"));

/** A PDF opened with pdf.js; pages are rendered on demand. The text layer is never used. */
export class PdfSource {
	private readonly task: PDFDocumentLoadingTask;
	private readonly doc: PDFDocumentProxy;
	readonly path: string;

	private constructor(task: PDFDocumentLoadingTask, doc: PDFDocumentProxy, path: string) {
		this.task = task;
		this.doc = doc;
		this.path = path;
	}

	static async open(path: string): Promise<PdfSource> {
		const data = new Uint8Array(readFileSync(path));
		const task = getDocument({
			data,
			verbosity: 0,
			standardFontDataUrl: `${join(PDFJS_ROOT, "standard_fonts")}/`,
			cMapUrl: `${join(PDFJS_ROOT, "cmaps")}/`,
			cMapPacked: true,
			wasmUrl: `${join(PDFJS_ROOT, "wasm")}/`,
		});
		const doc = await task.promise;
		return new PdfSource(task, doc, path);
	}

	get numPages(): number {
		return this.doc.numPages;
	}

	/**
	 * Render a 1-based page at `dpi` (reduced if the result would exceed `maxPixels`) to raw RGBA pixels, so the
	 * page is never lossily encoded before the final view.
	 */
	async renderRaw(pageNumber: number, dpi: number, maxPixels: number): Promise<RawImage> {
		const page = await this.doc.getPage(pageNumber);
		try {
			const base = page.getViewport({ scale: 1 });
			let scale = dpi / 72;
			const pixels = base.width * scale * base.height * scale;
			if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
			const viewport = page.getViewport({ scale });
			const width = Math.max(1, Math.floor(viewport.width));
			const height = Math.max(1, Math.floor(viewport.height));
			const canvas = createCanvas(width, height);
			const context = canvas.getContext("2d");
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, width, height);
			await page.render({
				// pdf.js types reference DOM canvases; @napi-rs/canvas is API-compatible in Node.
				canvas: canvas as any,
				canvasContext: context as any,
				viewport,
			}).promise;
			return { data: Buffer.from(canvas.data()), width, height, channels: 4 };
		} finally {
			page.cleanup();
		}
	}

	async close(): Promise<void> {
		await this.task.destroy();
	}
}
