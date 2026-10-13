import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChronoConfig, Mode, ServiceTier, ToolName } from "../config.ts";
import type { ImageProfile } from "../inputs/image-profile.ts";
import type { ImageLoader, PreparedImage } from "../inputs/images.ts";
import type { OpenRouterPreferences } from "../routing.ts";
import type { LoadedSchema } from "../schemas/registry.ts";
import type { PythonRunner } from "./python-tool.ts";
import {
	type DocPaths,
	type DocState,
	type InputKind,
	isDone,
	sha256Text,
	type UnitRecord,
	unitFileName,
} from "./state.ts";

export interface UnitSources {
	/** Decoder for the page image of an image unit (PDF pages are rendered on demand, never stored lossily). */
	image(unit: UnitRecord): { key: string; loader: ImageLoader };
	/** Text of a text unit. */
	text(unit: UnitRecord): string;
	/** Copy the chunk files the agent may read (previous, current, and up to two ahead) into work/source/. */
	materialize(unit: UnitRecord): void;
	/** Number of lines in the converted text document (text units only). */
	totalLines?: number;
}

/** Everything the extension and message builders need for one agent session. */
export interface SessionRuntime {
	paths: DocPaths;
	/** The agent's working directory (paths.workDir). */
	workDir: string;
	mode: Mode;
	inputKind: InputKind;
	schema: LoadedSchema;
	config: ChronoConfig;
	state: DocState;
	/** Units this session must finish, in document order. */
	batch: UnitRecord[];
	/** The agent's tools in this session (see config TOOL_NAMES). */
	tools: ReadonlySet<ToolName>;
	documentLabel: string;
	contextImages: Array<{ label: string; image: PreparedImage }>;
	/** Image size limits and provider fidelity parameters for the session's model. */
	imageProfile: ImageProfile;
	/** OpenRouter provider preferences for the session's model (undefined for other providers). */
	routing?: OpenRouterPreferences;
	/** OpenAI service tier sent with the session's requests (set only for OpenAI models used with an API key). */
	serviceTier?: ServiceTier;
	/** Upstream providers that served the session's requests (OpenRouter reports them in every stream chunk). */
	servedBy?: Set<string>;
	/** pi's compaction reserve for the session's model (from the user's pi settings). */
	reserveTokens?: number;
	sources: UnitSources;
	/** Size (base64 characters) of the current unit's page image as delivered; it is protected in every request. */
	pageImageBytes?: number;
	/** Runs the python tool's scripts (default: the local interpreter; tests inject their own). */
	pythonRunner?: PythonRunner;
	/** Consecutive units closed for review in this run of the document (shared by its sessions), and the limit. */
	reviewStreak?: { count: number; limit: number };
	persist(): void;
	log(message: string): void;
}

export function unitById(runtime: SessionRuntime, id: string): UnitRecord | undefined {
	return runtime.state.units.find((unit) => unit.id === id);
}

/** Neighbor in document order (not batch order). */
export function neighbor(runtime: SessionRuntime, unit: UnitRecord, offset: number): UnitRecord | undefined {
	return runtime.state.units.find((candidate) => candidate.index === unit.index + offset);
}

/** The canonical copy of a finished unit (immune to later edits in work/). */
export function committedPath(runtime: Pick<SessionRuntime, "paths" | "mode">, unit: UnitRecord): string {
	return join(runtime.paths.committedDir, unitFileName(runtime.mode, unit));
}

/**
 * The canonical content of a finished unit, checked against the hash recorded when it was finished. `problem`
 * is set when the copy is missing or was changed since; `content` is then undefined. A unit closed for review
 * without a file has neither.
 */
export function readCommitted(
	runtime: Pick<SessionRuntime, "paths" | "mode">,
	unit: UnitRecord,
): { content?: string; problem?: string } {
	if (!isDone(unit)) return {};
	const path = committedPath(runtime, unit);
	const name = `run/committed/${unitFileName(runtime.mode, unit)}`;
	if (!existsSync(path)) {
		return unit.contentHash || unit.status === "committed" ? { problem: `${name} is missing` } : {};
	}
	const content = readFileSync(path, "utf8");
	if (unit.contentHash && sha256Text(content) !== unit.contentHash) {
		return { problem: `${name} was changed after the unit was finished` };
	}
	return { content };
}
