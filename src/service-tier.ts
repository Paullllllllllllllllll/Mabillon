import type { ServiceTier } from "./config.ts";

/** The parts of a model that decide whether its requests can carry an OpenAI service tier. */
export interface TieredModel {
	provider: string;
	id: string;
	api: string;
}

/** Waits between retries after transient provider errors under flex, in ms: flex capacity can be short for a while. */
export const FLEX_RETRY_DELAYS = [60_000, 120_000, 300_000, 600_000, 900_000];

/** Request timeout under flex (pi's default is its 5-minute HTTP idle timeout); OpenAI suggests 15 minutes. */
export const FLEX_TIMEOUT_MS = 900_000;

/**
 * Whether the model's requests go to OpenAI's Responses API, the API-key route. The ChatGPT login of pi uses
 * the same provider and API (it differs only in the credential, see checkServiceTierRoute); the legacy ChatGPT
 * backend is provider openai-codex with API openai-codex-responses.
 */
export function isOpenAIResponses(model: Pick<TieredModel, "provider" | "api"> | undefined): boolean {
	return model?.provider === "openai" && model.api === "openai-responses";
}

/**
 * Refuse a service tier for a model that is not reached through OpenAI's API with an API key: OpenRouter, the
 * ChatGPT login (an OAuth token, also provider openai), and other providers. `authType` is the credential pi uses for
 * the model's provider (a stored credential wins over OPENAI_API_KEY).
 */
export function checkServiceTierRoute(
	tier: ServiceTier,
	model: TieredModel | undefined,
	authType: "api_key" | "oauth" | undefined,
): void {
	const option = `--service-tier ${tier} (service_tier)`;
	if (!model) {
		throw new Error(`${option} needs an OpenAI model given with --model (openai/<id>, used with an API key)`);
	}
	const key = `${model.provider}/${model.id}`;
	if (!isOpenAIResponses(model)) {
		throw new Error(
			`${option} applies only to OpenAI models used with an API key (openai/<id>); ${key} is not one (OpenRouter, the ChatGPT login and other providers take no service tier)`,
		);
	}
	if (authType === "oauth") {
		throw new Error(
			`${option} applies only to requests made with an OpenAI API key, but pi uses the ChatGPT login stored for provider openai for ${key} (a stored login takes precedence over OPENAI_API_KEY); leave the option out or replace the login with an API key`,
		);
	}
	if (authType !== "api_key") {
		throw new Error(`${option}: no OpenAI API key found for ${key} (set OPENAI_API_KEY or add a key in pi)`);
	}
}

/** Set the service tier on a request body, in place. Returns true when anything changed. */
export function applyServiceTier(payload: unknown, tier: ServiceTier | undefined): boolean {
	if (!tier || !payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const body = payload as Record<string, unknown>;
	if (body.service_tier === tier) return false;
	body.service_tier = tier;
	return true;
}

/**
 * A copy of the model whose `samplingParams` carry the service tier, so that requests that bypass
 * before_provider_request (pi's compaction summaries) send it too: pi's OpenAI Responses client merges
 * `model.samplingParams` into every request body. The model itself when nothing would change; the registry's model
 * object is never modified.
 */
export function withServiceTier<T extends { samplingParams?: Record<string, unknown> }>(
	model: T,
	tier: ServiceTier | undefined,
): T {
	if (!tier || model.samplingParams?.service_tier === tier) return model;
	return { ...model, samplingParams: { ...model.samplingParams, service_tier: tier } };
}

/** Waits between retries after transient provider errors: longer under flex. */
export function retryDelaysFor(tier: ServiceTier | undefined, standard: number[]): number[] {
	return tier === "flex" ? FLEX_RETRY_DELAYS : standard;
}
