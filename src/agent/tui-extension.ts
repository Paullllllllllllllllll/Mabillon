import { existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChronoConfig } from "../config.ts";
import { applyImageParams, type ModelIdentity, resolveImageProfile, withMaxEdge } from "../inputs/image-profile.ts";
import {
	describePrepared,
	ENHANCEMENTS,
	type Enhancement,
	fileLoader,
	type ImageLoader,
	prepareImage,
} from "../inputs/images.ts";
import { PdfSource } from "../inputs/pdf.ts";
import { loadTextDocument } from "../inputs/text.ts";
import { applyOpenRouterPreferences, openRouterPreferences, withOpenRouterRouting } from "../routing.ts";
import { loadSchemaFile, resolveSchema } from "../schemas/registry.ts";
import { readUtf8File } from "../util.ts";
import { formatIssues, type Issue } from "../verify/issues.ts";
import { verifyUnitContent } from "../verify/verify.ts";

/**
 * Interactive mode: pi's own TUI (with /login, /model, sessions) plus Mabillon's view and verify tools,
 * addressed by file path instead of the batch unit protocol.
 */
export function createTuiExtension(config: ChronoConfig) {
	const pdfs = new Map<string, Promise<PdfSource>>();

	/** Open PDFs by path and modification time; a failed open is not cached, so a fixed file can be retried. */
	const openPdf = (path: string, mtime: number): Promise<PdfSource> => {
		const key = `${path}@${mtime}`;
		let doc = pdfs.get(key);
		if (!doc) {
			doc = PdfSource.open(path);
			pdfs.set(key, doc);
			doc.catch(() => {
				if (pdfs.get(key) === doc) pdfs.delete(key);
			});
		}
		return doc;
	};

	const profileFor = (model: ModelIdentity | undefined) =>
		withMaxEdge(resolveImageProfile(model, config.imageQuality), config.maxImagePx);

	return (pi: ExtensionAPI) => {
		// pi shrinks tool-result images to 2,000 px unless auto-resize is off; view already sizes them for the model.
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI && pi.getSettings().images?.autoResize !== false) {
				ctx.ui.notify(
					"Mabillon: for full-resolution page views, turn off image auto-resize in /settings (pi caps images at 2,000 px otherwise).",
					"info",
				);
			}
		});

		// The routing travels with the selected model, so that requests outside before_provider_request (pi's
		// compaction summaries, cache warming) carry it too. Re-selecting the same model keeps the thinking level.
		const routeModel = async (model: ExtensionContext["model"]) => {
			if (!model) return;
			const routed = withOpenRouterRouting(model, openRouterPreferences(config, model));
			if (routed === model) return;
			const thinking = pi.getThinkingLevel();
			if ((await pi.setModel(routed)) && pi.getThinkingLevel() !== thinking) {
				pi.setThinkingLevel(thinking);
			}
		};
		pi.on("session_start", (_event, ctx) => routeModel(ctx.model));
		pi.on("model_select", (event) => routeModel(event.model));

		// A second layer for requests made while another model object is selected (e.g. after a registry refresh).
		pi.on("before_provider_request", (event, ctx) => {
			applyImageParams(event.payload, profileFor(ctx.model));
			applyOpenRouterPreferences(event.payload, openRouterPreferences(config, ctx.model));
			return event.payload;
		});

		const enhancement = Type.Union(ENHANCEMENTS.map((name) => Type.Literal(name)));
		pi.registerTool(
			defineTool({
				name: "view",
				label: "View",
				description:
					"Show an image file or a PDF page, whole or as a zoomed region (box), optionally enhanced, rotated, or with a coordinate grid.",
				promptSnippet: "view: show an image or PDF page, or zoom into a region of it",
				promptGuidelines: [
					"Use view with a box ({x, y, w, h} as page fractions) to read small, faint, or damaged text at full resolution.",
				],
				parameters: Type.Object({
					path: Type.String({ description: "Image file (png, jpg, tif, webp) or PDF." }),
					page: Type.Optional(
						Type.Integer({
							minimum: 1,
							description: "Page number (1-based) of a PDF or multi-page TIFF. Default 1.",
						}),
					),
					box: Type.Optional(
						Type.Object(
							{
								x: Type.Number({ minimum: 0, maximum: 1 }),
								y: Type.Number({ minimum: 0, maximum: 1 }),
								w: Type.Number({ minimum: 0, maximum: 1 }),
								h: Type.Number({ minimum: 0, maximum: 1 }),
							},
							{ description: "Region as page fractions: x, y = top-left corner; w, h = size." },
						),
					),
					scale: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })),
					rotate: Type.Optional(Type.Number({ description: "Clockwise rotation in degrees." })),
					enhance: Type.Optional(Type.Array(enhancement)),
					grid: Type.Optional(Type.Boolean({ description: "Overlay a labelled coordinate grid." })),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const path = resolve(ctx.cwd, params.path);
					if (!existsSync(path)) throw new Error(`File not found: ${params.path}`);
					const isPdf = extname(path).toLowerCase() === ".pdf";
					const page = params.page ?? 1;
					// The modification time is part of the cache keys, so a file changed during the session is read again.
					const mtime = statSync(path).mtimeMs;
					const loader: ImageLoader = isPdf
						? async () => (await openPdf(path, mtime)).renderRaw(page, config.dpi, config.maxRenderPixels)
						: fileLoader(path, params.page === undefined ? undefined : page - 1);
					const key = isPdf
						? `${path}@${mtime}#${page}@${config.dpi}:${config.maxRenderPixels}`
						: `${path}@${mtime}#${page - 1}`;
					const image = await prepareImage(key, loader, {
						box: params.box,
						scale: params.scale,
						rotate: params.rotate,
						enhance: params.enhance as Enhancement[] | undefined,
						grid: params.grid,
						limits: profileFor(ctx.model),
					});
					return {
						content: [
							{
								type: "text",
								text: describePrepared(params.page ? `${params.path} page ${page}` : params.path, image),
							},
							{ type: "image", data: image.data, mimeType: image.mimeType },
						],
						details: undefined,
					};
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "verify",
				label: "Verify",
				description:
					"Validate a unit file against a Mabillon/ChronoMiner schema: a transcription unit (.md with YAML front matter) or an extraction object (.json). Reports schema, rule, quality, and (with source) grounding issues.",
				promptSnippet: "verify: validate a transcription (.md) or extraction (.json) file against a schema",
				parameters: Type.Object({
					path: Type.String({ description: "File to check." }),
					schema: Type.String({
						description: "Schema name (see `mabillon schemas`) or path to a schema file.",
					}),
					source: Type.Optional(
						Type.String({ description: "Source text file, to check that verbatim fields occur in it." }),
					),
				}),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					const path = resolve(ctx.cwd, params.path);
					if (!existsSync(path)) throw new Error(`File not found: ${params.path}`);
					const schemaPath = resolve(ctx.cwd, params.schema);
					const schema = existsSync(schemaPath)
						? loadSchemaFile(schemaPath)
						: resolveSchema(
								params.schema,
								extname(path).toLowerCase() === ".md" ? "transcribe" : "extract",
								config.schemasDirs,
							);
					const sourceText = params.source
						? (await loadTextDocument(resolve(ctx.cwd, params.source))).text
						: undefined;
					const read = readUtf8File(path);
					const result = verifyUnitContent({
						schema,
						content: read.text,
						sourceText,
						groundingThreshold: config.groundingThreshold,
					});
					const issues: Issue[] = read.valid
						? result.issues
						: [
								{
									severity: "error",
									layer: "parse",
									message:
										"the file is not valid UTF-8 (probably written with another encoding); characters were lost",
								},
								...result.issues,
							];
					const errors = result.errors + (read.valid ? 0 : 1);
					return {
						content: [
							{
								type: "text",
								text: `${params.path} against ${schema.name}: ${errors} error(s), ${result.warnings} warning(s).\n${formatIssues(issues)}`,
							},
						],
						details: undefined,
					};
				},
			}),
		);

		pi.on("session_shutdown", async () => {
			for (const doc of pdfs.values()) {
				try {
					await (await doc).close();
				} catch {
					// ignore
				}
			}
			pdfs.clear();
		});
	};
}
