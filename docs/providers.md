# Models and providers

This page covers model names, credentials, the OpenRouter routing settings, and the
OpenAI service tiers.

## Credentials

Credentials and model settings are shared with pi: `~/.pi/agent/auth.json`,
`models.json` and `settings.json`. If you already use pi, nothing else is needed.
Otherwise, log in once through the interactive mode (`mabillon tui`, then `/login`),
or set API keys in the usual environment variables: `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and others.

## Model names

Models are named `<provider>/<id>`. pi names the ChatGPT subscription login `openai`,
for example `openai/gpt-6-luna`. `openai-codex` is a separate legacy provider that
needs its own login.

Open-weight models on OpenRouter carry the vendor in their id, for example
`openrouter/qwen/qwen3.8-27b`, `openrouter/moonshotai/kimi-k3` or
`openrouter/z-ai/glm-5.3-flash`.

## OpenRouter

### Data retention

Requests to OpenRouter ask for zero data retention by default (`provider.zdr` and
`data_collection: "deny"`). OpenRouter then routes only to endpoints that keep no
prompts or images. If a model has no such endpoint, the run stops with exit code 2 and
says so. `--no-zdr` (`zdr: false`) allows the other endpoints; use it when retention
is acceptable for the sources. ZDR set on the OpenRouter account applies in any case.

### Provider pinning

Different upstream providers can serve the same model with different quantizations and
image preprocessing. For comparable runs, pin them:

```yaml
model: openrouter/qwen/qwen3.8-27b
openrouter_providers: [deepinfra]     # tried in order, no fallback to other providers
openrouter_quantizations: [fp8, bf16] # serve only these precisions
```

The settings are merged over any `compat.openRouterRouting` from pi's `models.json`.
Mabillon's settings replace keys of the same name. `--no-zdr` only stops Mabillon from
adding `zdr`, so a `zdr: true` from `models.json` stays.

Each session records the merged preferences it sent (`routing`) and the upstream
providers that answered (`served_by`) in `session_settings` of the run metadata.

These settings apply only to models reached through OpenRouter. The data policies of
other providers (OpenAI, Anthropic, the ChatGPT login) are those of your account with
them.

## OpenAI service tiers

`--service-tier flex` (`service_tier: flex`) sends OpenAI's `service_tier` field with
every request. `priority`, `auto` and `default` are accepted as well.

Flex processing costs half the standard token price, and pi's cost accounting applies
the discount. It is slower, and when OpenAI lacks capacity it answers with HTTP 429
"Resource Unavailable", which is not billed. Under `flex`, Mabillon therefore retries
transient errors after 1, 2, 5, 10 and 15 minutes and raises pi's request timeout to
15 minutes. OpenAI rejects models that do not offer the tier.

Tiers apply only to OpenAI models used with an API key: `openai/<model>` with
`OPENAI_API_KEY` or an API key stored in pi. The ChatGPT login is also provider
`openai`, but it bills against the subscription and takes no tier. OpenRouter and the
legacy `openai-codex` provider take none either. A run with a tier and any such model,
or without `--model`, stops before touching a document (exit code 2). A ChatGPT login
stored in pi takes precedence over `OPENAI_API_KEY`.

Each session records the requested tier as `service_tier` in `session_settings`. In
`mabillon tui`, the tier from `mabillon.yaml` is sent only for OpenAI API-key requests.
