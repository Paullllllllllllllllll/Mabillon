import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConfig } from "../src/config.ts";
import { run } from "../src/driver.ts";
import { resolveImageProfile } from "../src/inputs/image-profile.ts";
import { prepareImage } from "../src/inputs/images.ts";
import { call, createFauxRuntime, makeImageFolder, messageText, say, tempDir } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const UNIT_FILE = [
	"---",
	"image_analysis: |",
	"  Single column of roman type.",
	"no_transcribable_text: false",
	"transcription_not_possible: false",
	"---",
	"To make a Tart of Hearbs.",
].join("\n");

const BAND = (y: number) => ({ x: 0, y, w: 1, h: 0.25 });

describe("view with boxes", () => {
	it("shows several regions in one call, one image each, and refuses box with boxes", async () => {
		const results: Array<{ text: string; images: number; error: boolean }> = [];
		const steps = [
			{ boxes: [BAND(0), BAND(0.25), BAND(0.5), BAND(0.75)], scale: 2 },
			{ box: BAND(0), boxes: [BAND(0.25)] },
		];
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "user") return call("view", steps[0]);
			if (last.role === "toolResult" && last.toolName === "view") {
				results.push({
					text: messageText(last),
					images: last.content.filter((block) => block.type === "image").length,
					error: last.isError,
				});
				return results.length < steps.length
					? call("view", steps[results.length])
					: call("write", { path: "units/p0001.md", content: UNIT_FILE });
			}
			if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
			return say("Done.");
		};
		const faux = await createFauxRuntime(responder);
		cleanups.push(faux.cleanup);
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "book"), 1);
		const summary = await run({
			mode: "transcribe",
			inputs: [folder],
			config: mergeConfig({ model: "faux/faux-1", out: join(root, "out") }),
			log: () => {},
			services: { modelRuntime: faux.modelRuntime, agentDir: faux.agentDir, settings: {} },
		});
		expect(summary.documents[0].committed).toBe(1);
		expect(results[0].images).toBe(4);
		expect(results[0].text).toMatch(/region 4 of 4: region x=0\.000\.\.1\.000, y=0\.750\.\.1\.000/);
		expect(results[1]).toMatchObject({ images: 0, error: true });
		expect(results[1].text).toMatch(/either box or boxes/);
	});

	it("refuses a batch that would not fit next to the kept images instead of losing regions", async () => {
		const results: string[] = [];
		const responder = (context: TranscriptContext) => {
			const last = context.messages[context.messages.length - 1];
			if (last.role === "user") return call("view", { boxes: [BAND(0), BAND(0.25), BAND(0.5), BAND(0.75)] });
			if (last.role === "toolResult" && last.toolName === "view") {
				results.push(messageText(last));
				return call("write", { path: "units/p0001.md", content: UNIT_FILE });
			}
			if (last.role === "toolResult" && last.toolName === "write") return call("verify", { final: true });
			return say("Done.");
		};
		const faux = await createFauxRuntime(responder);
		cleanups.push(faux.cleanup);
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "book"), 1);
		const contexts = await makeImageFolder(join(root, "context"), 17);
		const contextImages = Array.from({ length: 17 }, (_, i) => join(contexts, `scan_${i + 1}.png`));
		const summary = await run({
			mode: "transcribe",
			inputs: [folder],
			config: mergeConfig({ model: "faux/faux-1", out: join(root, "out"), contextImages }),
			log: () => {},
			services: { modelRuntime: faux.modelRuntime, agentDir: faux.agentDir, settings: {} },
		});
		expect(summary.documents[0].committed).toBe(1);
		// The generic profile carries 20 images per request: 17 context images and the page leave 2.
		expect(results[0]).toMatch(/At most 2 region\(s\) fit/);
	});

	it("magnifies a small region up to 8x within the model's limits", async () => {
		const root = tempDir();
		const folder = await makeImageFolder(join(root, "book"), 1);
		const page = join(folder, "scan_1.png");
		const limits = resolveImageProfile(undefined, "max");
		const box = { x: 0.1, y: 0.1, w: 0.1, h: 0.05 };
		const eight = await prepareImage(`${page}#8`, page, { box, scale: 8, limits });
		// 80 x 55 px region
		expect(eight.contentWidth).toBe(640);
		const huge = await prepareImage(`${page}#huge`, page, { box: { x: 0, y: 0, w: 1, h: 1 }, scale: 8, limits });
		expect(Math.max(huge.contentWidth, huge.contentHeight)).toBeLessThanOrEqual(limits.maxEdge);
	});
});
