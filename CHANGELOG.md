# Changelog

- **v0.9.0** (13 October 2026) -- `view` takes `boxes`, up to four page regions in
  one call with one image each, and magnifies up to 8x; a batch that would not fit
  into one request next to the context images and the unit's page is refused with
  the number of regions that fit instead of losing regions unseen. The method steps
  of transcription and extraction now have the agent check its draft against the page
  systematically, in overlapping bands magnified only as far as needed, and the
  system prompt ends with a completion section that follows what the prompting guides
  of the Claude 5.5, GPT-6, Qwen and Kimi models share (an explicit completion
  condition, persistence until it holds, one check after the last change, marking
  what cannot be read); both change the system prompt of every arm. New opt-in tool
  `python` (`--python`, image units): scripts on lossless page images with a helper
  module (`python/pagetools.py`), images saved to `scratch/show/` returned to the
  model, no user environment variables passed on, and `python` may replace `view`
  in `--tools`. The scripts run in an OS sandbox adapted from pi's sandbox example on
  `@anthropic-ai/sandbox-runtime` 0.0.79 (new dependency): no network, writes only to
  `scratch/`, probed before the first document, failing closed with exit code 2;
  `--no-python-sandbox` runs them unsandboxed. Mabillon refuses links and junctions
  in `scratch/` instead of following them. New settings `python`, `python_path`,
  `python_timeout` and `python_sandbox`.
- **v0.8.0** (12 October 2026) -- Adds `--service-tier` (`service_tier`) for
  OpenAI's service tiers (`flex`, `priority`, `auto`, `default`). The tier is sent
  as `service_tier` with every request of OpenAI models used with an API key and
  recorded per session (`session_settings.service_tier`); a run with any other
  model or route, including OpenRouter and the ChatGPT login, stops at the start
  with exit code 2. Under `flex`, which OpenAI bills at half the standard price and
  pi costs accordingly, transient errors such as the 429 "Resource Unavailable"
  replies are retried after 1, 2, 5, 10 and 15 minutes, and pi's request timeout
  is raised to 15 minutes.
- **v0.7.2** (10 October 2026) -- Kimi models reached through OpenRouter keep at
  most 28 MB of images per request. OpenRouter rejects Kimi requests whose images
  exceed 30 MB (HTTP 413 "Downloaded image content cannot exceed 30MB"), which the
  open-weight budget of 32 MB allowed; agentic sessions with many enlarged views
  of dense pages failed this way. Other models and routes are unchanged.
- **v0.7.1** (5 October 2026) -- The test suite removes its temporary folders
  after each test file. It used to leave about 100 folders in the system temp
  directory per run; cleanup is best effort, and sharp's file cache is off in
  tests so that Windows releases the image files.
- **v0.7.0** (5 October 2026) -- Renames the tool from ChronoAgent to Mabillon
  to avoid confusion with the unrelated Chronos-Agent (Hufe et al. 2026), which
  is also built on pi. The package and command are now `mabillon`, the settings
  file is `mabillon.yaml` (or `.yml`), the default output folder is
  `mabillon_output/`, and the provenance and output metadata key is `mabillon`.
  Outputs and settings written under the old names are not read; rename them to
  reuse them.
- **v0.6.1** (4 October 2026) -- Fixes four review findings in the v0.6.0
  routing and image profiles. The OpenRouter routing now travels with the session's
  model (`compat.openRouterRouting`), so pi's compaction summaries and cache warming
  also request zero data retention and the pinned providers; before, they bypassed
  the request hook. `session_settings.routing` records the merged preferences that
  were sent, including those inherited from pi's `models.json`. The fallback ladder
  of open-weight models never enlarges an image and keeps the family's token grid,
  and DeepSeek V4.1 Flash images count row separators and markers against the
  1,024-token budget.

- **v0.6.0** (4 October 2026) -- Extends the image profiles to more model
  families: Gemma 4, Mistral Small and Medium (Pixtral encoder), Llama 4, DeepSeek
  V4.1 Flash and Nemotron 3 Nano Omni get their processors' limits and token-grid
  padding, Gemini reached through OpenRouter or another OpenAI-compatible host gets
  Gemini's limits instead of the generic ones, and the Gemini API's request budget
  follows its 100 MB inline limit. Non-Claude models served over the Anthropic
  messages API (Kimi coding plan, MiniMax, Vercel AI Gateway) no longer get
  Anthropic's image limits, and the Kimi coding plan's model names are recognized.

- **v0.5.0** (4 October 2026) -- Prepares Mabillon for comparisons with
  open-weight models. Qwen3-VL and Qwen3.5 and later, Kimi K2.5 and later, and the
  GLM vision models get image profiles that follow their processors' limits
  instead of the generic 2,000 px, with a fallback from max to high to standard,
  and images for them are padded to the processor's token grid so that hosts do
  not resample pages. Requests to OpenRouter ask for zero data retention by
  default (`--no-zdr` turns this off); `openrouter_providers` and
  `openrouter_quantizations` pin upstream providers and precisions, each session
  records its routing and the providers that served it, and a run without a
  matching endpoint stops with a clear message. An oversized request (HTTP 413)
  now triggers the image fallback.

- **v0.4.0** (4 October 2026) -- Prepares Mabillon for tool ablations. The
  new extraction tool `update_entry` changes single fields of an entry by JSON
  pointer, validated before anything is written. Bash is no longer in the default
  tool set and is available only as an add-on via `--bash` or `--tools`. The new
  option `--tools` sets the agent's exact tool set; view, read and verify stay
  mandatory, and prompts, refusals and tool results mention only enabled tools.
  Every run records its experiment (tool set, behavior-relevant settings, context
  and prompt hashes), the implementation version and commit, per-session settings
  and cap hits, and resumes under a different experiment are refused without
  changing state. Image fallback is scoped per document and can be disabled, line
  ranges that leave source lines uncovered are an error, and `status` checks that
  exports are current.
- **v0.3.1** (4 October 2026) -- Fixes the findings of a whole-repo review.
  Extraction now follows a schema's boundary policy: schemas that record
  page-local fragments are no longer told to
  complete entries from the next page. Committing an empty extraction of a page or
  substantial chunk needs a confirmation, `add_entries` corrections keep source
  order through a `position` parameter, and EPUB chapters can no longer be dropped
  silently. A broken user schema no longer falls back to the bundled one, schemas
  without an entries array are refused, `verify` reads strictly as UTF-8, `status`
  reports failed exports, null counts as a varying page field, and the stop after
  three reviewed units in a row takes effect at once.
- **v0.3.0** (4 October 2026) -- Adds the extraction tool `add_entries`, which
  appends schema-validated entries to the current unit without rewriting the
  file, removes single entries by number, and reports a numbered entry index and
  the chunk coverage after every call. Invalid entries are rejected one by one
  under IDs that the agent must resolve by resending or dropping them; pending
  rejections persist across sessions and block the first commit. Unit files are
  written pretty-printed, schemas with chained local references are supported,
  and the prompt tells the agent to fix single entries instead of emptying a
  unit. In live runs with gpt-6-luna on a four-recipe chunk, complete extractions
  rose from 4 of 9 runs to 6 of 6.
- **v0.2.0** (4 October 2026) -- Hardens runs against silent data loss and
  corruption. Committed units are checked against their recorded hashes on resume
  and export, damaged ones are reopened, and resumes refuse changed source text
  while restoring altered work copies. Document locks are taken through an
  exclusive guard. Merged extraction output that fails validation now fails the
  run. Unit files that are not valid UTF-8 or that lost characters are rejected.
  Verification refuses once before an emptied extraction or one with low verbatim
  coverage is committed, and exports carry every unit's remaining issues. Git Bash
  installed per user is found on Windows, and runs without a shell drop the bash
  tool. The release also fixes stem collisions, rowspan tables, line-range
  validation and config validation; refreshes the bundled ChronoMiner schemas and
  adds ChronoTranscriber's bibliography schema; and corrects model IDs to the
  `openai` provider used by the ChatGPT login.
- **v0.1.0** (2 October 2026) -- First beta: page-by-page transcription and
  chunk-by-chunk extraction on the pi harness with an enforced unit gate,
  schema verification, grounding checks, resumable runs and the ChronoTranscriber
  and ChronoMiner schema format.
