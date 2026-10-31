import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
	applyImageParams,
	downgradeProfile,
	type ImageProfile,
	resolveImageProfile,
	withMaxEdge,
} from "../src/inputs/image-profile.ts";
import { describePrepared, fitFactor, prepareImage } from "../src/inputs/images.ts";

describe("image profiles", () => {
	it("chooses provider-specific limits", () => {
		const gpt56 = resolveImageProfile(
			{ provider: "openai-codex", id: "gpt-5.6-luna", api: "openai-codex-responses" },
			"max",
		);
		expect(gpt56.openaiDetail).toBe("original");
		expect(gpt56.maxPixels).toBe(30_000 * 1024);
		const gpt55 = resolveImageProfile({ provider: "openai", id: "gpt-5.5", api: "openai-responses" }, "max");
		expect(gpt55).toMatchObject({ openaiDetail: "original", maxEdge: 6000, maxPixels: 10_240_000 });
		const gpt55pro = resolveImageProfile({ provider: "openai", id: "gpt-5.5-pro", api: "openai-responses" }, "max");
		expect(gpt55pro).toMatchObject({ openaiDetail: "high", maxEdge: 2048 });
		const gpt52 = resolveImageProfile({ provider: "openai", id: "gpt-5.2", api: "openai-responses" }, "max");
		expect(gpt52.openaiDetail).toBe("high");
		expect(
			resolveImageProfile({ provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" }, "high").openaiDetail,
		).toBe("high");
		const opus48 = resolveImageProfile(
			{ provider: "anthropic", id: "claude-opus-4-8", api: "anthropic-messages" },
			"max",
		);
		expect(opus48.maxEdge).toBe(2576);
		const haiku = resolveImageProfile(
			{ provider: "anthropic", id: "claude-haiku-4-5", api: "anthropic-messages" },
			"max",
		);
		expect(haiku.maxEdge).toBe(1568);
		const bedrock = resolveImageProfile(
			{ provider: "amazon-bedrock", id: "anthropic.claude-opus-4-7-v1:0", api: "bedrock-converse-stream" },
			"max",
		);
		expect(bedrock.maxEdge).toBe(2576);
		expect(bedrock.maxBytes).toBeLessThan(3.75 * 1024 * 1024);
		const gemini3 = resolveImageProfile(
			{ provider: "google", id: "gemini-3.1-pro-preview", api: "google-generative-ai" },
			"max",
		);
		expect(gemini3.geminiPartResolution).toBe("MEDIA_RESOLUTION_ULTRA_HIGH");
		const gemini25 = resolveImageProfile(
			{ provider: "google", id: "gemini-2.5-pro", api: "google-generative-ai" },
			"max",
		);
		expect(gemini25.geminiGlobalResolution).toBe("MEDIA_RESOLUTION_HIGH");
		expect(
			resolveImageProfile({ provider: "ollama", id: "llava:13b", api: "openai-completions" }, "max").maxEdge,
		).toBe(2000);
		expect(resolveImageProfile(undefined, "max").maxEdge).toBe(2000);
	});

	it("sets OpenAI detail and Gemini media resolution in request payloads", () => {
		const openai = resolveImageProfile({ provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" }, "max");
		const payload = {
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "x" },
						{ type: "input_image", detail: "auto", image_url: "data:" },
					],
				},
				{ type: "function_call_output", output: [{ type: "input_image", detail: "auto", image_url: "data:" }] },
			],
		};
		expect(applyImageParams(payload, openai)).toBe(true);
		expect(JSON.stringify(payload)).not.toContain('"auto"');
		expect(JSON.stringify(payload).match(/"original"/g)).toHaveLength(2);

		const gemini = resolveImageProfile(
			{ provider: "google", id: "gemini-3.5-flash", api: "google-generative-ai" },
			"high",
		);
		const request = {
			contents: [{ role: "user", parts: [{ text: "x" }, { inlineData: { mimeType: "image/jpeg", data: "abc" } }] }],
			config: {},
		};
		applyImageParams(request, gemini);
		expect(request.contents[0].parts[1]).toMatchObject({ mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" } });
		expect(request.contents[0].parts[0]).not.toHaveProperty("mediaResolution");

		const gemini25 = resolveImageProfile(
			{ provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai" },
			"max",
		);
		const old: { contents: unknown[]; config: Record<string, unknown> } = { contents: [], config: {} };
		applyImageParams(old, gemini25);
		expect(old.config.mediaResolution).toBe("MEDIA_RESOLUTION_HIGH");
	});

	it("downgrades step by step", () => {
		const max = resolveImageProfile({ provider: "openai", id: "gpt-5.6-sol", api: "openai-responses" }, "max");
		const first = downgradeProfile(max)!;
		expect(first.openaiDetail).toBe("high");
		const second = downgradeProfile(first)!;
		expect(second.openaiDetail).toBeUndefined();
		expect(downgradeProfile(second)).toBeUndefined();
	});

	it("keeps full pages at native resolution within the model limit and respects the byte budget", async () => {
		const page = await sharp({ create: { width: 2500, height: 3300, channels: 3, background: "#f0e6d2" } })
			.png()
			.toBuffer();
		const large = await prepareImage("test:large", page, {
			limits: { maxEdge: 10_000, maxPixels: 30_000_000, maxBytes: 40e6 },
		});
		expect([large.width, large.height]).toEqual([2500, 3300]);
		const anthropic = await prepareImage("test:large", page, {
			limits: { maxEdge: 1568, maxPixels: 1568 * 784, maxBytes: 4.5e6 },
		});
		expect(Math.max(anthropic.width, anthropic.height)).toBeLessThanOrEqual(1568);
		expect(anthropic.width * anthropic.height).toBeLessThanOrEqual(1568 * 784);
		const crop = await prepareImage("test:large", page, {
			box: { x: 0.1, y: 0.1, w: 0.1, h: 0.05 },
			limits: { maxEdge: 2576, maxPixels: 3_750_000, maxBytes: 4.5e6 },
		});
		expect(crop.width).toBe(750);
		const noisy = await sharp({
			create: {
				width: 1500,
				height: 1500,
				channels: 3,
				background: "#808080",
				noise: { type: "gaussian", mean: 128, sigma: 60 },
			},
		})
			.png()
			.toBuffer();
		const small = await prepareImage("test:noisy", noisy, {
			limits: { maxEdge: 1500, maxPixels: 3e6, maxBytes: 200_000 },
		});
		expect(Math.ceil(Buffer.from(small.data, "base64").length / 3) * 4).toBeLessThanOrEqual(200_000);
	});
	it("gives open-weight vision models their processors' limits, aligned to the token grid", () => {
		const openrouter = (id: string) => ({ provider: "openrouter", id, api: "openai-completions" });
		const qwen = resolveImageProfile(openrouter("qwen/qwen3.8-27b"), "max");
		expect(qwen).toMatchObject({ align: 32, patchSize: 32, maxPatches: 16_384, maxPixels: 16_777_216 });
		expect(resolveImageProfile(openrouter("qwen/qwen3.8-27b:free"), "max").align).toBe(32);
		expect(resolveImageProfile(openrouter("qwen/qwen3-vl-235b-a22b-instruct"), "max").align).toBe(32);
		expect(resolveImageProfile(openrouter("qwen/qwen3.8-27b"), "high")).toMatchObject({
			maxPatches: 2_560,
			maxPixels: 2_621_440,
		});
		const kimi = resolveImageProfile(openrouter("moonshotai/kimi-k3"), "max");
		expect(kimi).toMatchObject({ align: 28, maxPatches: 16_384, maxEdge: 7_168, maxPixels: 16_384 * 784 });
		expect(resolveImageProfile(openrouter("moonshotai/kimi-k3"), "high").maxEdge).toBe(4_096);
		expect(
			resolveImageProfile({ provider: "moonshotai", id: "kimi-k2.5", api: "openai-completions" }, "max").align,
		).toBe(28);
		expect(resolveImageProfile(openrouter("moonshotai/kimi-k2-thinking"), "max").align).toBeUndefined();
		const glm = resolveImageProfile(openrouter("z-ai/glm-5.3-flash"), "max");
		expect(glm).toMatchObject({ align: 28, maxPatches: 12_288, maxRequestImages: 8 });
		expect(resolveImageProfile(openrouter("z-ai/glm-4.6v"), "max").align).toBe(28);
		expect(resolveImageProfile(openrouter("z-ai/glm-5v-turbo"), "max").align).toBe(28);
		// Text-only GLM 5.3 and older Qwen models keep the generic limits.
		expect(resolveImageProfile(openrouter("z-ai/glm-5.3"), "max").align).toBeUndefined();
		expect(resolveImageProfile(openrouter("qwen/qwen2.5-vl-72b-instruct"), "max").maxEdge).toBe(2000);
		expect(resolveImageProfile(openrouter("qwen/qwen3.8-27b"), "standard").align).toBeUndefined();
		// Claude through OpenRouter keeps Anthropic's limits.
		expect(resolveImageProfile(openrouter("anthropic/claude-opus-5.5"), "max").maxEdge).toBe(2576);
		// Other models served over the Anthropic messages API keep their own limits.
		const anthropicApi = (provider: string, id: string) => ({ provider, id, api: "anthropic-messages" });
		expect(resolveImageProfile(anthropicApi("kimi-coding", "k3"), "max").align).toBe(28);
		expect(resolveImageProfile(anthropicApi("kimi-coding", "kimi-for-coding"), "max").align).toBe(28);
		expect(resolveImageProfile(anthropicApi("other", "k3"), "max").align).toBeUndefined();
		expect(resolveImageProfile(anthropicApi("vercel-ai-gateway", "moonshotai/kimi-k3"), "max").align).toBe(28);
		expect(resolveImageProfile(anthropicApi("vercel-ai-gateway", "alibaba/qwen3.8-27b"), "max").align).toBe(32);
	});

	it("keeps Kimi requests through OpenRouter under its 30 MB image limit, fallback included", () => {
		const MB = 1024 * 1024;
		const openrouter = (id: string) => ({ provider: "openrouter", id, api: "openai-completions" });
		const kimi = resolveImageProfile(openrouter("moonshotai/kimi-k3"), "max");
		expect(kimi.maxRequestImageBytes).toBe(28 * MB);
		expect(kimi.lower?.maxRequestImageBytes).toBe(28 * MB);
		expect(resolveImageProfile(openrouter("qwen/qwen3.8-27b"), "max").maxRequestImageBytes).toBe(32 * MB);
		expect(
			resolveImageProfile({ provider: "moonshotai", id: "kimi-k3", api: "openai-completions" }, "max")
				.maxRequestImageBytes,
		).toBe(32 * MB);
	});

	it("covers Gemma, Mistral, Llama 4, DeepSeek and Nemotron, and Gemini through other hosts", () => {
		const openrouter = (id: string) => ({ provider: "openrouter", id, api: "openai-completions" });
		const gemma = resolveImageProfile(openrouter("google/gemma-4-31b-it:free"), "max");
		expect(gemma).toMatchObject({ align: 48, maxPatches: 1_120, maxPixels: 1_120 * 48 * 48 });
		expect(resolveImageProfile(openrouter("google/gemma-4-26b-a4b-it"), "high").maxPatches).toBe(560);
		expect(
			resolveImageProfile({ provider: "google", id: "gemma-4-31b-it", api: "google-generative-ai" }, "max").align,
		).toBe(48);
		expect(resolveImageProfile(openrouter("google/gemma-3-27b-it"), "max").align).toBeUndefined();

		const mistral = resolveImageProfile(openrouter("mistralai/mistral-medium-3-5"), "max");
		expect(mistral).toMatchObject({ align: 28, maxEdge: 1_540, maxRequestImages: 8 });
		for (const id of ["mistral-small-2603", "mistral-medium-latest", "mistral-small-3.2-24b-instruct"]) {
			expect(resolveImageProfile({ provider: "mistral", id, api: "mistral-conversations" }, "max").align).toBe(28);
		}
		// One tier only: "high" uses the same limits, and the fallback is the standard profile.
		expect(resolveImageProfile(openrouter("mistralai/mistral-medium-3-5"), "high").maxEdge).toBe(1_540);
		expect(downgradeProfile(mistral)?.label).toBe("standard (fallback)");

		expect(resolveImageProfile(openrouter("meta-llama/llama-4-maverick"), "max")).toMatchObject({
			align: 336,
			maxPatches: 16,
		});
		expect(resolveImageProfile(openrouter("deepseek/deepseek-v4.1-flash"), "max").align).toBe(42);
		expect(resolveImageProfile(openrouter("deepseek/deepseek-v4-flash-vision-exp"), "max").align).toBeUndefined();
		expect(
			resolveImageProfile(openrouter("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"), "max").maxPatches,
		).toBe(3_328);

		const gemini = resolveImageProfile(openrouter("google/gemini-3.5-flash"), "max");
		expect(gemini).toMatchObject({ maxEdge: 3072, label: "Gemini (host default media resolution)" });
		expect(gemini.geminiPartResolution).toBeUndefined();
		expect(downgradeProfile(gemini)).toBeUndefined();
		const direct = resolveImageProfile(
			{ provider: "google", id: "gemini-3.5-flash", api: "google-generative-ai" },
			"max",
		);
		expect(direct.maxRequestImageBytes).toBe(64 * 1024 * 1024);
		expect(
			resolveImageProfile({ provider: "google-vertex", id: "gemini-3.5-flash", api: "google-vertex" }, "max")
				.maxRequestImageBytes,
		).toBe(17 * 1024 * 1024);
	});

	it("fills whole Llama 4 tiles", () => {
		const llama = resolveImageProfile(
			{ provider: "openrouter", id: "meta-llama/llama-4-scout", api: "openai-completions" },
			"max",
		);
		const f = fitFactor(2480, 3508, 1, llama);
		const tiles = Math.ceil((2480 * f) / 336 - 1e-9) * Math.ceil((3508 * f) / 336 - 1e-9);
		expect(tiles).toBeLessThanOrEqual(16);
		expect(tiles).toBeGreaterThanOrEqual(12);
	});

	it("falls back from max to high to standard for open-weight models, keeping a --max-image-px cap", () => {
		const max = resolveImageProfile(
			{ provider: "openrouter", id: "z-ai/glm-5.3-flash", api: "openai-completions" },
			"max",
		);
		const high = downgradeProfile(max)!;
		expect(high).toMatchObject({ maxPatches: 4_096, align: 28 });
		expect(high.label).toMatch(/fallback/);
		const standard = downgradeProfile(high)!;
		expect(standard).toMatchObject({ maxEdge: 2000, maxRequestImages: 8, align: 28 });
		expect(downgradeProfile(standard)).toBeUndefined();
		const capped = withMaxEdge(max, 1500);
		expect(capped.maxEdge).toBe(1500);
		expect(downgradeProfile(capped)?.maxEdge).toBe(1500);
		expect(downgradeProfile(downgradeProfile(capped)!)?.maxEdge).toBe(1500);
	});

	it("never enlarges an image when an open-weight model falls back, and keeps the token grid", () => {
		const ids = [
			"qwen/qwen3.8-27b",
			"moonshotai/kimi-k3",
			"z-ai/glm-5.3-flash",
			"google/gemma-4-31b-it",
			"mistralai/mistral-medium-3-5",
			"meta-llama/llama-4-maverick",
			"deepseek/deepseek-v4.1-flash",
			"nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
		];
		const fitted = (profile: ImageProfile) => {
			const f = fitFactor(2480, 3508, 1, profile);
			const align = profile.align ?? 1;
			const pad = (size: number) => Math.ceil(Math.floor(size * f + 1e-9) / align) * align;
			return { width: pad(2480), height: pad(3508) };
		};
		for (const id of ids) {
			for (const quality of ["max", "high"] as const) {
				let profile: ImageProfile | undefined = resolveImageProfile(
					{ provider: "openrouter", id, api: "openai-completions" },
					quality,
				);
				const align = profile.align;
				expect(align, id).toBeGreaterThan(1);
				let steps = 0;
				for (let lower = downgradeProfile(profile); lower; lower = downgradeProfile(lower)) {
					const label = `${id} ${quality}: ${profile.label} -> ${lower.label}`;
					expect(lower.align, label).toBe(align);
					expect(lower.patchSize, label).toBe(profile.patchSize);
					expect(lower.maxEdge, label).toBeLessThanOrEqual(profile.maxEdge);
					expect(lower.maxPixels, label).toBeLessThanOrEqual(profile.maxPixels);
					expect(lower.maxPatches!, label).toBeLessThanOrEqual(profile.maxPatches!);
					expect(lower.maxBytes, label).toBeLessThanOrEqual(profile.maxBytes);
					expect(lower.maxRequestImages, label).toBeLessThanOrEqual(profile.maxRequestImages);
					expect(lower.maxRequestImageBytes, label).toBeLessThanOrEqual(profile.maxRequestImageBytes);
					const above = fitted(profile);
					const below = fitted(lower);
					expect(below.width, label).toBeLessThanOrEqual(above.width);
					expect(below.height, label).toBeLessThanOrEqual(above.height);
					expect(below.width % align!, label).toBe(0);
					expect(below.height % align!, label).toBe(0);
					profile = lower;
					steps++;
				}
				expect(steps, id).toBeGreaterThanOrEqual(1);
				expect(profile.label).toBe("standard (fallback)");
			}
		}
	});

	it("counts DeepSeek's row separators and markers against its 1,024 tokens", () => {
		const deepseek = resolveImageProfile(
			{ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", api: "openai-completions" },
			"max",
		);
		const tokens = (width: number, height: number, wanted: number) => {
			const f = fitFactor(width, height, wanted, deepseek);
			const cols = Math.ceil(Math.floor(width * f + 1e-9) / 42);
			const rows = Math.ceil(Math.floor(height * f + 1e-9) / 42);
			return rows * (cols + 1) + 2;
		};
		// Tall and narrow: 4 columns, so each row costs 5 tokens (238 rows unscaled would need 1,192).
		const tall = tokens(168, 9_996, 1);
		expect(tall).toBeLessThanOrEqual(1_024);
		expect(tall).toBeGreaterThan(990);
		// Wide and short, and an enlarged tall region.
		const wide = tokens(9_996, 420, 1);
		expect(wide).toBeLessThanOrEqual(1_024);
		expect(wide).toBeGreaterThan(990);
		expect(tokens(84, 2_000, 3)).toBeLessThanOrEqual(1_024);
		expect(tokens(2_480, 3_508, 1)).toBeLessThanOrEqual(1_024);
		// Below the budget nothing is scaled.
		expect(fitFactor(9_996, 168, 1, deepseek)).toBe(1);
		// Profiles without the overheads count patches as before.
		expect(fitFactor(168, 9_996, 1, { ...deepseek, rowTokens: undefined, imageTokens: undefined })).toBe(1);
	});

	it("pads images with white to the token grid instead of resampling them", async () => {
		const page = await sharp({ create: { width: 2500, height: 3300, channels: 3, background: "#000000" } })
			.png()
			.toBuffer();
		const qwen = resolveImageProfile(
			{ provider: "openrouter", id: "qwen/qwen3.8-27b", api: "openai-completions" },
			"max",
		);
		const full = await prepareImage("test:black", page, { limits: qwen });
		// 2500 x 3300 fits the budget, so the content stays at native size; the padding completes the 32 px grid.
		expect([full.contentWidth, full.contentHeight]).toEqual([2500, 3300]);
		expect([full.width, full.height]).toEqual([2528, 3328]);
		const pixels = await sharp(Buffer.from(full.data, "base64")).raw().toBuffer({ resolveWithObject: true });
		const at = (x: number, y: number) => pixels.data[(y * pixels.info.width + x) * pixels.info.channels];
		expect(at(2499, 100)).toBeLessThan(40);
		expect(at(2520, 100)).toBeGreaterThan(215);
		expect(at(100, 3320)).toBeGreaterThan(215);
		const text = describePrepared("Page p0001", full);
		expect(text).toMatch(/shown at 2500x3300 px \(padded with white at the right and bottom to 2528x3328 px/);
		expect(text).not.toMatch(/Downscaled/);

		// A smaller budget downscales; the padded size stays within the token budget.
		const high = resolveImageProfile(
			{ provider: "openrouter", id: "qwen/qwen3.8-27b", api: "openai-completions" },
			"high",
		);
		const reduced = await prepareImage("test:black", page, { limits: high });
		expect(reduced.width % 32).toBe(0);
		expect(reduced.height % 32).toBe(0);
		expect((reduced.width / 32) * (reduced.height / 32)).toBeLessThanOrEqual(2_560);
		expect((reduced.width / 32) * (reduced.height / 32)).toBeGreaterThan(2_400);

		// Rotated, enlarged regions are aligned too.
		const kimi = resolveImageProfile(
			{ provider: "openrouter", id: "moonshotai/kimi-k3", api: "openai-completions" },
			"max",
		);
		const region = await prepareImage("test:black", page, {
			box: { x: 0.1, y: 0.1, w: 0.1, h: 0.05 },
			rotate: 90,
			limits: kimi,
		});
		expect(region.width % 28).toBe(0);
		expect(region.height % 28).toBe(0);
		expect(region.contentHeight).toBe(750);
	});

	it("uses the full edge budget without alignment", () => {
		// 3300 px scaled to exactly 2576 px, not 1% less.
		const factor = fitFactor(2500, 3300, 1, { maxEdge: 2576, maxPixels: 30_000_000, maxBytes: 1e9 });
		expect(Math.floor(3300 * factor + 1e-9)).toBe(2576);
		const pixels = fitFactor(2500, 3300, 1, { maxEdge: 10_000, maxPixels: 3_750_000, maxBytes: 1e9 });
		expect(Math.floor(2500 * pixels + 1e-9) * Math.floor(3300 * pixels + 1e-9)).toBeGreaterThan(3_700_000);
	});
});
