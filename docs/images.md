# Image fidelity

This page describes how Mabillon prepares page images for the model: the size limits
per provider, the padding for open-weight models, the quality tiers, the fallbacks,
and the rendering limits. Higher fidelity costs more input tokens.

## Provider limits

Mabillon renders, crops and encodes page images itself, with one JPEG encode at
quality 90 and full chroma, from lossless data. It sends them at the largest size the
model accepts, together with the provider parameter that makes the provider look at
them at full resolution. This is `--image-quality max`, the default.

| Provider and model | Full-page limit | Request parameter |
| --- | --- | --- |
| OpenAI GPT-5.6, GPT-6 (API and ChatGPT login) | 30,000 patches of 32 px (about 30 MP), 10,000 px edge | `detail: "original"` |
| OpenAI GPT-5.4, GPT-5.5 | 10,000 patches (10.24 MP), 6,000 px edge | `detail: "original"` |
| Other OpenAI vision models | 2.56 MP, 2,048 px edge | `detail: "high"` |
| Anthropic Opus 4.7 and later, Sonnet, Fable and Haiku 5 and later | 3.75 MP, 2,576 px edge | none (server-side limit) |
| Other Anthropic models | 1.15 MP, 1,568 px edge | none |
| Gemini 3 and later | 3,072 px edge | per-image `media_resolution` ultra high (page), global high (zoomed views) |
| Gemini 2.x | 3,072 px edge | `media_resolution` high |
| Qwen3-VL, Qwen3.5 and later (any host) | 16,384 tokens of 32 px (16.8 MP), 10,000 px edge | none (host's image processor) |
| Kimi K2.5 and later (any host) | 16,384 tokens of 28 px (12.8 MP), 7,168 px edge | none |
| GLM-4.xV, GLM-5V, GLM-5.3-Flash (any host) | 12,288 tokens of 28 px (9.6 MP), 8 images per request | none |
| Gemini through OpenRouter or another OpenAI-compatible host | 3,072 px edge | none (Google's default, 1,120 tokens for Gemini 3) |
| Gemma 4 (any host) | 1,120 tokens of 48 px (2.58 MP) | none |
| Mistral Small 3.1 and later, Medium 3 and later, Magistral | 1,540 px longest edge, 28 px tokens, 8 images per request | none |
| Llama 4 Scout and Maverick | 16 tiles of 336 px (1.81 MP), 8 images per request | none |
| DeepSeek V4.1 Flash | 1,024 tokens of 42 px, counting one separator per row and two markers (about 1.7 MP) | none |
| Nemotron 3 Nano Omni | 3,328 tokens of 32 px (3.41 MP) | none |
| Others | 4 MP, 2,000 px edge | none |

Open-weight models have no request parameter for image detail, because the image
processor of the host decides. The limits in the table follow the published processor
configurations of the models. MiniMax M3 and Muse Glimmer keep the generic limits
until their published processor settings are confirmed.

## Padding

The processors of open-weight models round image sizes to their token grid, which
resamples the image. Mabillon avoids this by padding images with white at the right and
bottom to a multiple of the grid. The agent is told the size of the padding.

| Model family | Grid |
| --- | --- |
| Qwen, Nemotron | 32 px |
| Kimi, GLM, Mistral | 28 px |
| Gemma | 48 px |
| DeepSeek | 42 px |
| Llama 4 | whole 336 px tiles |

## Quality tiers

`--image-quality` takes three values:

- `max` (default) uses the limits above.
- `high` uses the cheaper high-detail modes. For Qwen it uses 2,560 tokens
  (Alibaba's default of 2.62 MP), for Kimi 4K (4,096 px, 8.8 MP) as Moonshot
  recommends, for GLM 4,096 tokens, and for Gemma 560 tokens. The other families have
  a single tier.
- `standard` uses pi's defaults (2,000 px).

`--max-image-px` lowers the edge limit further. It never raises it above the model's
limit.

## Fallbacks

A host that rejects an image falls back from `max` to `high` to `standard`. Each lower
tier keeps the family's token grid and never exceeds the tier above it. If a provider
rejects the image parameters, Mabillon falls back one level for that document and
retries the session. Each downgrade is recorded as `image_fallbacks` in the metadata.
`--no-image-fallback` fails the document instead.

A host may downscale large images on its own. Zoomed regions are cut from the
full-resolution page, so small type stays legible even where full-page views are
downscaled. The agent is told when a view is downscaled.

## Resolution and size limits

PDF pages are rendered at `--dpi` (default 300, at most `max_render_pixels`, default
30 MP). The full-resolution page of a PDF is the page as rendered, so raise `--dpi`
for high-resolution scans. Image files are decoded at most at 100 MP, and larger scans
are reduced on load. Files above 1,000 MP are refused.

In `mabillon tui`, pi resizes tool images to 2,000 px unless image auto-resize is
turned off in `/settings`. The TUI reminds you of this at start.
