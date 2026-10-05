import type { ChronoConfig } from "./config.ts";

/** The parts of a model that decide how its requests are routed. */
export interface RoutedModel {
	provider: string;
	baseUrl?: string;
}

/** OpenRouter provider preferences that Mabillon sets (the `provider` field of the request body). */
export interface OpenRouterPreferences {
	zdr?: boolean;
	data_collection?: "deny";
	order?: string[];
	allow_fallbacks?: boolean;
	quantizations?: string[];
}

export function isOpenRouter(model: RoutedModel | undefined): boolean {
	if (!model) return false;
	return model.provider === "openrouter" || /(^|[/.])openrouter\.ai(\/|$)/i.test(model.baseUrl ?? "");
}

/**
 * The provider preferences for a model reached through OpenRouter (empty when nothing is set), or undefined for other
 * providers. Zero data retention also denies data collection (a provider that keeps nothing cannot train on it); listed
 * providers are tried in order with no fallback to others, so that a run is served by the hosts it names.
 */
export function openRouterPreferences(
	config: Pick<ChronoConfig, "zdr" | "openrouterProviders" | "openrouterQuantizations">,
	model: RoutedModel | undefined,
): OpenRouterPreferences | undefined {
	if (!isOpenRouter(model)) return undefined;
	const preferences: OpenRouterPreferences = {
		...(config.zdr ? { zdr: true, data_collection: "deny" as const } : {}),
		...(config.openrouterProviders?.length ? { order: config.openrouterProviders, allow_fallbacks: false } : {}),
		...(config.openrouterQuantizations?.length ? { quantizations: config.openrouterQuantizations } : {}),
	};
	return preferences;
}

/**
 * Merge the preferences into an OpenRouter request body, in place, on top of any routing from pi's models.json
 * (`compat.openRouterRouting`). Returns true when anything changed.
 */
export function applyOpenRouterPreferences(payload: unknown, preferences: OpenRouterPreferences | undefined): boolean {
	if (!preferences || Object.keys(preferences).length === 0) return false;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const body = payload as Record<string, unknown>;
	const existing =
		body.provider && typeof body.provider === "object" ? (body.provider as Record<string, unknown>) : {};
	const merged = { ...existing, ...preferences };
	if (JSON.stringify(merged) === JSON.stringify(body.provider)) return false;
	body.provider = merged;
	return true;
}

/**
 * The provider object a model's requests carry: Mabillon's preferences merged over the routing from pi's
 * models.json (`compat.openRouterRouting`); Mabillon's settings win on shared keys. Undefined for other providers.
 */
export function effectiveRouting(
	model: (RoutedModel & { compat?: unknown }) | undefined,
	preferences: OpenRouterPreferences | undefined,
): Record<string, unknown> | undefined {
	if (!preferences) return undefined;
	const compat = model?.compat as { openRouterRouting?: unknown } | undefined;
	const inherited = compat?.openRouterRouting;
	return {
		...(inherited && typeof inherited === "object" ? (inherited as Record<string, unknown>) : {}),
		...preferences,
	};
}

/**
 * A copy of the model whose `compat.openRouterRouting` holds the effective routing, so that every request made with it
 * carries the preferences, including those that bypass before_provider_request (pi's compaction summaries, cache
 * warming). The model itself when nothing would change; the registry's model object is never modified.
 */
export function withOpenRouterRouting<T extends RoutedModel & { compat?: unknown }>(
	model: T,
	preferences: OpenRouterPreferences | undefined,
): T {
	if (!preferences || Object.keys(preferences).length === 0) return model;
	const routing = effectiveRouting(model, preferences);
	const compat = (model.compat ?? {}) as Record<string, unknown>;
	if (JSON.stringify(compat.openRouterRouting) === JSON.stringify(routing)) return model;
	return { ...model, compat: { ...compat, openRouterRouting: routing } };
}

/** The upstream provider named in an OpenRouter stream chunk ("provider": "DeepInfra"), if any. */
export function servingProvider(chunk: unknown): string | undefined {
	if (!chunk || typeof chunk !== "object") return undefined;
	const provider = (chunk as Record<string, unknown>).provider;
	return typeof provider === "string" && provider.trim() !== "" ? provider.trim() : undefined;
}

/** A short description of the preferences for logs. */
export function describePreferences(preferences: OpenRouterPreferences | undefined): string {
	if (!preferences) return "not routed through OpenRouter";
	if (Object.keys(preferences).length === 0) return "OpenRouter: default routing (zero data retention not requested)";
	const parts = [
		preferences.zdr ? "zero data retention" : "zero data retention not requested",
		...(preferences.order ? [`providers ${preferences.order.join(", ")} (no fallback)`] : []),
		...(preferences.quantizations ? [`quantizations ${preferences.quantizations.join(", ")}`] : []),
	];
	return `OpenRouter: ${parts.join("; ")}`;
}
