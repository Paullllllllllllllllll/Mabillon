import type { ImageLimits } from "./images.ts";

export const IMAGE_QUALITIES = ["max", "high", "standard"] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

export type OpenAIDetail = "original" | "high";
export type GeminiResolution = "MEDIA_RESOLUTION_HIGH" | "MEDIA_RESOLUTION_ULTRA_HIGH";

/**
 * How large the images sent to a model may be, and which provider parameters ask the provider to look at
 * them at full fidelity. Limits follow the providers' documented input caps (as tracked by ChronoTranscriber's
 * capability registry):
 * - OpenAI GPT-5.4/5.5: detail "original" up to 10,000 patches of 32 px (10.24 MP) and a 6,000 px edge; GPT-5.6 and
 *   GPT-6 raise the budget to 30,000 patches. Detail "high": 2.56 MP or a 2,048 px edge. GPT-5.5 Pro has no
 *   "original" tier.
 * - Anthropic: 2,576 px / about 3.75 MP for the high-resolution tier (Opus 4.7 and later, Sonnet 5 and later,
 *   Fable 5, Haiku 5); 1,568 px / about 1.15 MP otherwise. No request parameter exists; larger images are only
 *   downscaled server-side. With more than 20 images in one request, Anthropic limits each to 2,000 px.
 * - Gemini 3 and later: per-image media_resolution up to ULTRA_HIGH for images in user messages (the page), global
 *   HIGH for images in tool results (zoomed views); earlier Gemini: global HIGH.
 * - Gemini through OpenRouter or another OpenAI-compatible host: no media resolution parameter; Google's default for
 *   the model applies (1,120 tokens per image for Gemini 3). The Gemini API takes 100 MB of inline data per request
 *   since January 2026; Vertex AI 7 MB per inline image.
 * - Open-weight vision models (on OpenRouter or any other host) have no request parameter; the host's image processor
 *   decides. Their limits follow the models' published processor configurations (OPEN_WEIGHT_FAMILIES): Qwen3-VL and
 *   Qwen3.5 and later (16 px patches merged 2x2 into 32 px tokens, at most 16,384 tokens or 16.8 MP; 2.62 MP is
 *   Alibaba's default), Kimi K2.5 and later (MoonViT: 14 px patches merged into 28 px tokens, at most 65,536 patches
 *   and a 7,168 px edge; Moonshot recommends at most 4K), GLM vision models (14 px patches merged into 28 px tokens;
 *   12,288 tokens, the smaller of the published GLM-4.6V processor limits), Gemma 4 (16 px patches pooled 3x3 into
 *   48 px tokens, budgets up to 1,120 tokens), Mistral Small 3.1 and later and Medium 3 and later (Pixtral encoder,
 *   28 px tokens, 1,540 px longest edge), Llama 4 (up to 16 tiles of 336 px), DeepSeek V4.1 Flash (42 px tokens,
 *   1,024 tokens including row separators) and Nemotron 3 Nano Omni (32 px tokens, up to 3,328). Images are padded to
 *   the token grid (or to whole tiles) so that the host's processor does not resample them.
 */
export interface ImageProfile extends ImageLimits {
	/** OpenAI Responses input_image detail to request. */
	openaiDetail?: OpenAIDetail;
	/** Gemini 3+ per-part media resolution. */
	geminiPartResolution?: GeminiResolution;
	/** Gemini 2.x global media resolution. */
	geminiGlobalResolution?: "MEDIA_RESOLUTION_HIGH";
	/** Budget for all images kept in one request (base64 bytes). */
	maxRequestImageBytes: number;
	/** Maximum number of images kept in one request. */
	maxRequestImages: number;
	/** The next lower profile, for providers whose fallback is not derived from request parameters. */
	lower?: ImageProfile;
	label: string;
}

const MB = 1024 * 1024;

const STANDARD: ImageProfile = {
	maxEdge: 2000,
	maxPixels: 4_000_000,
	maxBytes: 4.5 * MB,
	maxRequestImageBytes: 20 * MB,
	maxRequestImages: 20,
	label: "standard (2,000 px)",
};

export interface ModelIdentity {
	provider: string;
	id: string;
	api: string;
}

function bareId(id: string): string {
	const lower = id.toLowerCase();
	return lower.includes("/") ? lower.slice(lower.lastIndexOf("/") + 1) : lower;
}

function isOpenAIResponses(api: string): boolean {
	return api === "openai-responses" || api === "openai-codex-responses" || api === "azure-openai-responses";
}

function isGoogle(api: string): boolean {
	return api.startsWith("google");
}

// By model id, not API: Kimi, MiniMax and the Vercel AI Gateway serve other models over the Anthropic messages API.
function isAnthropicModel(model: ModelIdentity): boolean {
	return bareId(model.id).includes("claude");
}

// Version numbers: one digit, or two digits not followed by more (so dated ids like opus-4-20250514 do not match).
const ANTHROPIC_HIGH_RES =
	/claude-(?:opus-4[-.](?:[7-9]|[1-9]\d)(?!\d)|(?:opus|sonnet|fable|haiku)-(?:[5-9]|[1-9]\d)(?!\d))/;
const OPENAI_ORIGINAL_30K = /^gpt-(?:5\.(?:[6-9]|[1-9]\d)|[6-9]|[1-9]\d)(?!\d)/;
const OPENAI_ORIGINAL = /^gpt-5\.[45](?!\d)(?!-pro)|^gpt-5\.4-pro/;
const GEMINI_PER_PART = /gemini-(?:[3-9]|[1-9]\d)(?!\d)|gemini-(?:flash|flash-lite|pro)-latest/;

interface OpenWeightTier {
	/** Pixels per visual token (patch size times the merge or pooling factor); images are padded to this grid. */
	align: number;
	maxPatches: number;
	maxEdge: number;
	/** Tokens added per row and per image, counted against maxPatches (see ImageLimits). */
	rowTokens?: number;
	imageTokens?: number;
	label: string;
}

interface OpenWeightFamily {
	match: (id: string, provider: string) => boolean;
	max: OpenWeightTier;
	/** A smaller budget for --image-quality high; families without one use the max tier. */
	high?: OpenWeightTier;
	maxRequestImages?: number;
	maxBytes?: number;
}

const NO_EDGE = 10_000;

/**
 * Open-weight vision models by family, from their published processor configurations (see ImageProfile). Tiled
 * encoders (Llama 4) are described as one tile per patch, so that the image fills whole tiles.
 */
const OPEN_WEIGHT_FAMILIES: OpenWeightFamily[] = [
	{
		// Qwen3-VL and the natively multimodal Qwen3.5 and later: 16 px patches merged 2x2.
		match: (id) => /^qwen3(?:\.\d+)?(?:[-:]|$)/.test(id),
		max: { align: 32, maxPatches: 16_384, maxEdge: NO_EDGE, label: "Qwen vision (up to 16,384 tokens of 32 px)" },
		high: { align: 32, maxPatches: 2_560, maxEdge: NO_EDGE, label: "Qwen vision (2,560 tokens of 32 px)" },
	},
	{
		// Kimi K2.5 and later (MoonViT: 14 px patches merged 2x2); the Kimi coding plan names them k3, k3-256k, ...
		match: (id, provider) =>
			/^kimi-k(?:2\.[5-9]|[3-9]|[1-9]\d)(?![\d.])/.test(id) ||
			(provider === "kimi-coding" && /^(?:k(?:[3-9]|[1-9]\d)(?![\d.])|kimi-for-coding)/.test(id)),
		max: { align: 28, maxPatches: 16_384, maxEdge: 7_168, label: "Kimi vision (up to 16,384 tokens of 28 px)" },
		high: { align: 28, maxPatches: 11_284, maxEdge: 4_096, label: "Kimi vision (4K, 4,096 px)" },
	},
	{
		// GLM-4.xV, GLM-5V and GLM-5.3-Flash: 14 px patches merged 2x2.
		match: (id) => /^glm-(?:\d+(?:\.\d+)?v|5\.(?:[3-9]|[1-9]\d)-flash)/.test(id),
		max: { align: 28, maxPatches: 12_288, maxEdge: 9_996, label: "GLM vision (up to 12,288 tokens of 28 px)" },
		high: { align: 28, maxPatches: 4_096, maxEdge: 9_996, label: "GLM vision (4,096 tokens of 28 px)" },
		maxRequestImages: 8,
	},
	{
		// Gemma 4: 16 px patches pooled 3x3, soft-token budgets up to 1,120 per image.
		match: (id) => /^gemma-(?:[4-9]|[1-9]\d)(?!\d)/.test(id),
		max: { align: 48, maxPatches: 1_120, maxEdge: NO_EDGE, label: "Gemma vision (up to 1,120 tokens of 48 px)" },
		high: { align: 48, maxPatches: 560, maxEdge: NO_EDGE, label: "Gemma vision (560 tokens of 48 px)" },
	},
	{
		// Mistral Small 3.1 and later, Medium 3 and later, Magistral (Pixtral encoder: 14 px patches merged 2x2,
		// longest edge 1,540 px). Mistral's API takes 8 images of 10 MB per request.
		match: (id) =>
			/^(?:mistral-(?:small|medium)-(?:3(?:[-.]|$)|latest|2[5-9]\d\d)|magistral-(?:small|medium))/.test(id),
		max: { align: 28, maxPatches: 3_025, maxEdge: 1_540, label: "Mistral vision (1,540 px, 28 px tokens)" },
		maxRequestImages: 8,
	},
	{
		// Llama 4 Scout and Maverick: up to 16 tiles of 336 px.
		match: (id) => /^llama-4-(?:scout|maverick)/.test(id),
		max: { align: 336, maxPatches: 16, maxEdge: 16 * 336, label: "Llama 4 vision (up to 16 tiles of 336 px)" },
		maxRequestImages: 8,
	},
	{
		// DeepSeek V4.1 Flash: 14 px patches downsampled 3x3, 1,024 tokens per image counting one separator per row and
		// the begin and end markers: rows * (columns + 1) + 2.
		match: (id) => /^deepseek-v4(?:\.|p)[1-9]-flash/.test(id),
		max: {
			align: 42,
			maxPatches: 1_024,
			rowTokens: 1,
			imageTokens: 2,
			maxEdge: NO_EDGE,
			label: "DeepSeek vision (up to 1,024 tokens of 42 px with row separators)",
		},
	},
	{
		// Nemotron 3 Nano Omni: 16 px patches, up to 13,312 of them, pixel-shuffled 2x2.
		match: (id) => /^nemotron-3-nano-omni/.test(id),
		max: { align: 32, maxPatches: 3_328, maxEdge: NO_EDGE, label: "Nemotron vision (up to 3,328 tokens of 32 px)" },
	},
];

/**
 * Open-weight models reached through OpenAI-compatible hosts. The byte limits are not documented by the hosts; 8 MB
 * per image leaves room for a full 300 DPI page at JPEG quality 90, and a rejection falls back one level.
 */
function openWeightProfile(family: OpenWeightFamily, quality: Exclude<ImageQuality, "standard">): ImageProfile {
	const maxRequestImages = family.maxRequestImages ?? 20;
	const base = { maxBytes: family.maxBytes ?? 8 * MB, maxRequestImageBytes: 32 * MB, maxRequestImages };
	const build = (tier: OpenWeightTier): ImageProfile => ({
		...base,
		maxEdge: tier.maxEdge,
		maxPixels: tier.maxPatches * tier.align * tier.align,
		patchSize: tier.align,
		maxPatches: tier.maxPatches,
		align: tier.align,
		...(tier.rowTokens ? { rowTokens: tier.rowTokens } : {}),
		...(tier.imageTokens ? { imageTokens: tier.imageTokens } : {}),
		label: tier.label,
	});
	// The last tier applies the generic standard limits on the family's token grid, never above the tier it follows.
	const withStandard = (above: ImageProfile): ImageProfile => {
		const align = above.align ?? 1;
		return {
			...above,
			lower: {
				...above,
				maxEdge: Math.min(STANDARD.maxEdge, above.maxEdge),
				maxPixels: Math.min(STANDARD.maxPixels, above.maxPixels),
				maxPatches: Math.min(Math.floor(STANDARD.maxPixels / (align * align)), above.maxPatches ?? Infinity),
				maxBytes: Math.min(STANDARD.maxBytes, above.maxBytes),
				maxRequestImageBytes: Math.min(STANDARD.maxRequestImageBytes, above.maxRequestImageBytes),
				maxRequestImages: Math.min(STANDARD.maxRequestImages, above.maxRequestImages),
				lower: undefined,
				label: "standard (fallback)",
			},
		};
	};
	if (!family.high) return withStandard(build(family.max));
	const high = withStandard(build(family.high));
	return quality === "high" ? high : { ...build(family.max), lower: { ...high, label: `${high.label} (fallback)` } };
}

/**
 * OpenRouter rejects Kimi requests whose images exceed 30 MB (413 "Downloaded image content cannot exceed 30MB");
 * Kimi through OpenRouter keeps at most 28 MB of images per request.
 */
const OPENROUTER_KIMI_REQUEST_IMAGE_BYTES = 28 * MB;

function capRequestImageBytes(profile: ImageProfile, cap: number): ImageProfile {
	return {
		...profile,
		maxRequestImageBytes: Math.min(profile.maxRequestImageBytes, cap),
		...(profile.lower ? { lower: capRequestImageBytes(profile.lower, cap) } : {}),
	};
}

export function resolveImageProfile(model: ModelIdentity | undefined, quality: ImageQuality): ImageProfile {
	const profile = familyProfile(model, quality);
	return model?.provider === "openrouter" && model.id.startsWith("moonshotai/kimi-")
		? capRequestImageBytes(profile, OPENROUTER_KIMI_REQUEST_IMAGE_BYTES)
		: profile;
}

function familyProfile(model: ModelIdentity | undefined, quality: ImageQuality): ImageProfile {
	if (!model || quality === "standard") return STANDARD;
	const id = bareId(model.id);

	if (isAnthropicModel(model)) {
		// Bedrock caps inline images at 3.75 MB; the Anthropic API at 5 MB per image and 32 MB per request.
		const bedrock = model.api.startsWith("bedrock");
		const base = {
			maxBytes: bedrock ? 3.5 * MB : 4.5 * MB,
			maxRequestImageBytes: bedrock ? 18 * MB : 24 * MB,
			maxRequestImages: 20,
		};
		return ANTHROPIC_HIGH_RES.test(id)
			? { ...base, maxEdge: 2576, maxPixels: 3_750_000, label: "Anthropic high-resolution (2,576 px)" }
			: { ...base, maxEdge: 1568, maxPixels: 1_150_000, label: "Anthropic standard (1,568 px)" };
	}

	if (isOpenAIResponses(model.api) && id.startsWith("gpt-")) {
		const high: ImageProfile = {
			maxEdge: 2048,
			maxPixels: 2_560_000,
			maxBytes: 20 * MB,
			maxRequestImageBytes: 45 * MB,
			maxRequestImages: 100,
			openaiDetail: "high",
			label: 'OpenAI detail "high" (2,048 px)',
		};
		if (quality === "high") return high;
		if (OPENAI_ORIGINAL_30K.test(id)) {
			return {
				maxEdge: 10_000,
				maxPixels: 30_000 * 32 * 32,
				patchSize: 32,
				maxPatches: 30_000,
				maxBytes: 20 * MB,
				maxRequestImageBytes: 45 * MB,
				maxRequestImages: 100,
				openaiDetail: "original",
				label: 'OpenAI detail "original" (up to 30,000 patches)',
			};
		}
		if (OPENAI_ORIGINAL.test(id)) {
			return {
				maxEdge: 6000,
				maxPixels: 10_240_000,
				patchSize: 32,
				maxPatches: 10_000,
				maxBytes: 20 * MB,
				maxRequestImageBytes: 45 * MB,
				maxRequestImages: 100,
				openaiDetail: "original",
				label: 'OpenAI detail "original" (10,000 patches)',
			};
		}
		return high;
	}

	if (id.startsWith("gemini-") || (isGoogle(model.api) && id.includes("gemini"))) {
		const base = {
			maxEdge: 3072,
			maxPixels: 9_437_184,
			// Vertex AI takes 7 MB per inline image. Inline request data: 100 MB on the Gemini API since January
			// 2026, about 20 MB elsewhere.
			maxBytes: 7 * MB,
			maxRequestImageBytes: model.api === "google-generative-ai" ? 64 * MB : 17 * MB,
			maxRequestImages: 100,
		};
		// Through OpenRouter and other OpenAI-compatible hosts there is no media resolution parameter; Google's
		// default for the model applies (1,120 tokens per image for Gemini 3).
		if (!isGoogle(model.api)) return { ...base, label: "Gemini (host default media resolution)" };
		if (GEMINI_PER_PART.test(id)) {
			return {
				...base,
				geminiPartResolution: quality === "max" ? "MEDIA_RESOLUTION_ULTRA_HIGH" : "MEDIA_RESOLUTION_HIGH",
				// Images inside function responses (zoomed views) cannot carry a per-part setting; the global
				// setting is their floor.
				geminiGlobalResolution: "MEDIA_RESOLUTION_HIGH",
				label: `Gemini media resolution ${quality === "max" ? "ultra high" : "high"}`,
			};
		}
		return { ...base, geminiGlobalResolution: "MEDIA_RESOLUTION_HIGH", label: "Gemini media resolution high" };
	}

	const family = OPEN_WEIGHT_FAMILIES.find((candidate) => candidate.match(id, model.provider));
	if (family) return openWeightProfile(family, quality);

	return STANDARD;
}

/** Apply an explicit --max-image-px on top of a profile (it can only lower the limit). */
export function withMaxEdge(profile: ImageProfile, maxEdge: number | undefined): ImageProfile {
	if (!maxEdge || maxEdge <= 0 || maxEdge >= profile.maxEdge) return profile;
	return {
		...profile,
		maxEdge,
		lower: profile.lower && withMaxEdge(profile.lower, maxEdge),
		label: `${profile.label}, capped at ${maxEdge} px`,
	};
}

function visit(value: unknown, fn: (node: Record<string, unknown>) => void): void {
	if (Array.isArray(value)) {
		for (const item of value) visit(item, fn);
	} else if (value && typeof value === "object") {
		fn(value as Record<string, unknown>);
		for (const child of Object.values(value)) visit(child, fn);
	}
}

/**
 * Raise the provider-side image fidelity of a request payload, in place. Returns true when anything changed.
 * Handles OpenAI Responses (input_image.detail) and Gemini (media resolution on top-level content parts only:
 * images inside functionResponse parts do not accept it).
 */
export function applyImageParams(payload: unknown, profile: ImageProfile): boolean {
	if (!payload || typeof payload !== "object") return false;
	let changed = false;
	if (profile.openaiDetail) {
		visit(payload, (node) => {
			if (node.type === "input_image" && node.detail !== profile.openaiDetail) {
				node.detail = profile.openaiDetail;
				changed = true;
			}
		});
	}
	const object = payload as Record<string, unknown>;
	if (profile.geminiPartResolution && Array.isArray(object.contents)) {
		for (const content of object.contents as Array<Record<string, unknown>>) {
			if (!Array.isArray(content?.parts)) continue;
			for (const part of content.parts as Array<Record<string, unknown>>) {
				const inline = part?.inlineData as Record<string, unknown> | undefined;
				if (inline && String(inline.mimeType ?? "").startsWith("image/")) {
					part.mediaResolution = { level: profile.geminiPartResolution };
					changed = true;
				}
			}
		}
	}
	if (profile.geminiGlobalResolution && object.contents !== undefined) {
		const config = (object.config ?? {}) as Record<string, unknown>;
		if (config.mediaResolution !== profile.geminiGlobalResolution) {
			config.mediaResolution = profile.geminiGlobalResolution;
			object.config = config;
			changed = true;
		}
	}
	return changed;
}

/** A weaker profile to fall back to when a provider rejects the image parameters. */
export function downgradeProfile(profile: ImageProfile): ImageProfile | undefined {
	if (profile.lower) return profile.lower;
	if (profile.openaiDetail === "original") {
		return {
			...profile,
			maxEdge: 2048,
			maxPixels: 2_560_000,
			patchSize: undefined,
			maxPatches: undefined,
			openaiDetail: "high",
			label: 'OpenAI detail "high" (fallback)',
		};
	}
	if (profile.geminiPartResolution === "MEDIA_RESOLUTION_ULTRA_HIGH") {
		return {
			...profile,
			geminiPartResolution: "MEDIA_RESOLUTION_HIGH",
			label: "Gemini media resolution high (fallback)",
		};
	}
	if (profile.openaiDetail || profile.geminiPartResolution || profile.geminiGlobalResolution) {
		return { ...STANDARD, label: "standard (fallback)" };
	}
	return undefined;
}
