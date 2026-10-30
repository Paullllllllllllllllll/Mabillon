# Mabillon v0.9.0

<img src="assets/logo.svg" alt="Mabillon logo" width="64" align="right">

Mabillon is an agent for transcribing historical sources and extracting
schema-validated structured data from them. It is named after Jean Mabillon
(1632-1707), whose *De re diplomatica* founded the critical study of documents.
It is built on the
[pi](https://github.com/earendil-works/pi) agent harness (pinned to
`@earendil-works/pi-coding-agent` 1.0.0) and reuses the JSON schema format of
ChronoTranscriber and ChronoMiner (`{name, strict, schema}` wrappers, the
`{contains_no_content_of_requested_type, entries}` envelope).

Instead of one model call per page, a single agent works through a document page by
page (or chunk by chunk) with a deliberately small tool set: it looks at the page,
writes its transcription or extraction to a file, zooms into difficult regions,
re-reads, corrects, and validates its own output with a verifier before it may move
on. Output quality scales with the model and its reasoning effort.

Status: beta. The harness is covered by end-to-end tests against a scripted model;
transcription quality has to be judged on your own material.

## Modes

| Mode | Input | Unit | Output |
| --- | --- | --- | --- |
| `transcribe` | PDFs, image folders, single images, multi-page TIFFs | page | per-page objects validated against a transcription schema, plus Markdown |
| `extract` | PDFs and images (read as images; any text layer is ignored) | page | one object validated against an extraction schema, plus provenance |
| `extract` | text: .txt, .md, .csv, .tsv, .json, .xml/TEI, .html, .docx, .epub | chunk (about 2,500 tokens, cut at semantic boundaries) | same |

The modes are separate on purpose. To extract from your own transcriptions, run
`transcribe` first and then `extract` on the resulting `.md` file.

## Installation

Requires Node.js 22.19 or newer.

```bash
git clone https://github.com/Paullllllllllllllllll/Mabillon.git
cd Mabillon
npm install        # also builds dist/ via the prepare script
npm link           # makes `mabillon` available on your PATH (optional)
```

Credentials and model settings are shared with pi (`~/.pi/agent/auth.json`,
`models.json`, `settings.json`). If you already use pi, nothing else is needed.
Otherwise log in once through the interactive mode:

```bash
mabillon tui        # then type /login and pick a provider (e.g. ChatGPT, Claude, Gemini)
```

API keys in the usual environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...) work as well.

Models are named `<provider>/<id>`. pi 1.0.0 names the ChatGPT subscription login
`openai` (for example `openai/gpt-6-luna`); `openai-codex` is a separate legacy
provider that needs its own login. Open-weight models on OpenRouter carry the
vendor in their id, for example `openrouter/qwen/qwen3.8-27b`,
`openrouter/moonshotai/kimi-k3`, or `openrouter/z-ai/glm-5.3-flash`.

### OpenRouter and data retention

Requests to OpenRouter ask for zero data retention by default (`provider.zdr` and
`data_collection: "deny"`): OpenRouter then routes only to endpoints that keep no
prompts or images. If a model has no such endpoint, the run stops with exit code 2
and says so; `--no-zdr` (`zdr: false`) allows the other endpoints when retention is
acceptable for the sources. ZDR set on the OpenRouter account applies in any case.

Different upstream providers can serve the same model with different
quantizations and image preprocessing. For comparable runs, pin them:

```yaml
model: openrouter/qwen/qwen3.8-27b
openrouter_providers: [deepinfra]     # tried in order, no fallback to other providers
openrouter_quantizations: [fp8, bf16] # serve only these precisions
```

The settings are merged over any `compat.openRouterRouting` from pi's
`models.json`: Mabillon's settings replace keys of the same name, and `--no-zdr`
only stops Mabillon from adding `zdr`, so a `zdr: true` from `models.json` stays.
Each session records the merged preferences it sent (`routing`) and the
upstream providers that answered (`served_by`) in `session_settings` of the run
metadata. These settings apply only to models reached through OpenRouter; the data
policies of other providers (OpenAI, Anthropic, the ChatGPT login) are those of your
account with them.

### OpenAI service tiers

`--service-tier flex` (`service_tier: flex`) sends OpenAI's `service_tier` field
with every request; `priority`, `auto` and `default` are accepted as well. Flex
processing costs half the standard token price, and pi's cost accounting applies
the discount. It is slower, and when OpenAI lacks capacity it answers with HTTP 429
"Resource Unavailable" (not billed). Under `flex`, Mabillon therefore retries
transient errors after 1, 2, 5, 10 and 15 minutes and raises pi's request timeout
to 15 minutes. OpenAI rejects models that do not offer the tier.

Tiers apply only to OpenAI models used with an API key (`openai/<model>` with
`OPENAI_API_KEY` or an API key stored in pi). The ChatGPT login is also provider
`openai`, but it bills against the subscription and takes no tier; OpenRouter and
the legacy `openai-codex` provider take none either. A run with a tier and any such
model, or without `--model`, stops before touching a document (exit code 2). A
ChatGPT login stored in pi takes precedence over `OPENAI_API_KEY`. Each session
records the requested tier as `service_tier` in `session_settings`. In `mabillon
tui`, the tier from `mabillon.yaml` is sent only for OpenAI API-key requests.

## Usage

```bash
# Transcribe a PDF (default schema: diplomatic_markdown_transcription)
mabillon transcribe book.pdf --model openai/gpt-6-luna --thinking medium

# Transcribe a folder of page scans, 20 pages per agent session
mabillon transcribe scans/book_1747/ --units-per-session 20

# Extract recipes from the transcription produced above
mabillon extract mabillon_output/book/book.md --schema <schema>

# Extract bibliographic records directly from page images, first 40 pages only
mabillon extract catalogue.pdf --schema <schema> --units 1-40

# Validate any file against a schema (no model involved)
mabillon verify mabillon_output/book/book.json
mabillon verify entries.json --schema <schema> --source catalogue.docx

# List bundled and user schemas
mabillon schemas

# Progress of runs (reads their state; no model involved)
mabillon status mabillon_output/
```

`mabillon --help` lists every option. All options except `--json`, `--quiet`,
`--config`, and `--source` can also be set in a `mabillon.yaml` in the working
directory (or `--config file`), using the option names in snake_case or camelCase.
Relative paths in the file are resolved against the file's folder.

Values are checked before any document is touched (exit code 2 on errors):
`grounding_threshold` must lie in (0, 1] and use a decimal point (`0.8`, not `0,8`);
counts and sizes such as `units_per_session`, `dpi`, or `chunk_tokens` must be at
least 1; `tool_soft_cap` may not exceed `tool_hard_cap` (it is not raised silently).

```yaml
model: openai/gpt-6-luna
thinking: medium
units_per_session: 20
compact_at_tokens: 250000
tool_soft_cap: 30
tool_hard_cap: 40
image_quality: max
dpi: 300
schemas_dirs:
  - ../ChronoMiner/schemas
context:
  - corpus_context.md
```

## How a run works

1. Inputs are resolved into documents. A folder that directly contains images is one
   document (pages in natural sort order; each page of a multi-page TIFF is a unit,
   while directories the file marks as reduced-resolution copies, such as pyramid
   levels and thumbnails, are skipped). PDFs and text files in the same folder are
   separate documents, and subfolders are searched the same way (up to eight levels;
   hidden folders, Mabillon output folders, and the `--out` folder are skipped).
   Documents whose names collide get distinct output folders.
2. Each document gets an output folder `mabillon_output/<stem>/` next to the input
   (or under `--out`), with the final files at the top.
3. The document is split into units: pages `p0001, p0002, ...` (PDF pages are
   rendered at 300 DPI on demand) or text chunks `c0001, ...`.
4. One agent session handles up to `units_per_session` units (default 20). When it is
   done, a fresh session continues with the next units and receives a handoff: the
   agent's `notes.md`, the end of the previous unit, and any carry-over note.
5. Within a session the agent receives one unit at a time and must commit it before
   the next one is delivered (see below).
6. After every session, the final outputs are assembled from the committed units.
   Interrupted runs resume from the last committed unit when the same command is run
   again; `--force` starts over, `--redo-review` re-runs units that were closed for
   review (within the `--units` selection, if one is given). A run refuses to resume
   when the source, the schema or its rules file, or the chunking changed in the
   meantime (line endings of the schema file do not count), or when the experiment
   arm differs: the tool set, the context files, the settings that shape the
   agent's work (caps, units per session, compaction, grounding threshold, image
   settings, chunking, fallback and line-range options) or the system prompt.
   The model and thinking level may change; each unit records the session that
   committed it. A run from before experiment records resumes only if the agent
   never worked on it (no sessions, drafts, notes or finished units). A refused
   resume changes neither the state nor the outputs.
   Only one process can work on a document at a time.

### Tools

The agent's tools are pi's `read`, `write`, `edit` and (opt-in) `bash`, plus
Mabillon's own:

- `read`, `write`, `edit`, `bash` (pi built-ins; `bash` only with `--bash`),
- `view` (image modes): the current, previous, or next page, whole or as a zoomed
  region (`box` in page fractions), or up to four regions in one call (`boxes`, one
  image each), magnified up to 8x, with optional contrast, threshold, sharpen
  (enhancements are applied in the order given), rotation, and a labelled
  coordinate grid. A `boxes` call that would not fit into one request next to the
  context images and the unit's page is refused with the number of regions that fit,
  so no region is dropped unseen,
- `add_entries` (extraction with an `entries` array): changes the current unit
  file without resending or reading it, creating it with the schema's envelope if
  needed. `remove` deletes entries by number, `entries` adds new ones (at the end,
  or at `position`, so a correction can take the place of the removed entry),
  `fields` sets the other top-level fields, and `resolves` settles rejections.
  Each new entry is validated against the schema's entry structure; an invalid
  one is not added and gets a rejection ID (R1, R2, ...) and the position it
  belongs at. It stays pending, also across sessions, until a later call names it
  in `resolves`, with the corrected entry or alone to drop it. Pending rejections
  produce a `verify` warning, and the first `final=true` is refused while any
  remain. Every result ends with a numbered index of the file's entries (with the
  slots of pending rejections) and, for text units, the share of the chunk the
  verbatim fields cover. The file is written as indented UTF-8 JSON,
- `update_entry` (extraction with an `entries` array): changes fields of one entry
  by its number: each change sets a JSON pointer within the entry
  (`/title_original`, `/ingredients/2/quantity_original`; `-` appends to an array)
  to a value. The changed entry must still match the schema's entry structure,
  otherwise nothing changes; for text units the result reports the grounding of
  the changed entry and the chunk coverage,
- `verify`: validates the current unit file; with `final=true` it commits the unit,
- `python` (image units, opt-in with `--python`): runs a Python script the agent writes,
  with the work folder as current folder. The current, previous and next page are
  written as lossless PNGs at full resolution to `source/<id>.png` (paths in
  `source/pages.json` and the variables `MABILLON_PAGE`, `MABILLON_PREVIOUS_PAGE`,
  `MABILLON_NEXT_PAGE`). `scratch/pagetools.py`, copied from `python/pagetools.py` at
  the first session, has helpers for crops, magnification, background removal,
  binarization (Otsu, Sauvola), deskewing, line and column detection from projection
  profiles, captioned line strips and side-by-side comparisons of letter forms; the
  agent may change and extend it, and its version stays for later units. Images the
  script saves to `scratch/show/` (emptied before each call) are returned, at most four
  per call, prepared like `view` images but never enlarged; stdout and stderr are
  returned as well (the last 6,000 characters each). A call stops after
  `python_timeout` seconds (default 120). The interpreter is `python_path` (default
  `python`) and needs numpy and Pillow; OpenCV is used when installed. No environment
  variable of yours reaches the script.

`--tools read,write,verify` (or `tools:` in `mabillon.yaml`) sets the exact tool
set, for example for ablations. The default is `read`, `write`, `edit`, `view`,
`verify`, `add_entries` and `update_entry`; tools that do not apply are left out
(`view` outside image units, `add_entries` and `update_entry` outside extraction).
`verify`, `view` (image units) and `read` (text units) cannot be left out, and the
set needs a tool that creates the unit file (`write`; in extraction also
`add_entries`; `bash` and `python` are only add-ons, since the soft cap takes them
away); other
sets and unknown names are refused (exit code 2). Hints of pi's own tools that
point to a disabled tool (read's "Use bash: sed ..." for an overlong line) are
rewritten. `--bash` adds
`bash` and `--no-bash` removes it. The prompt, the tool hints and the refusal
messages mention only the tools the agent has, and the effective set is recorded
per session in the state, as `tools` in the run metadata of the outputs, and per
document in the `--json` result.

`python` scripts run in an OS sandbox by default
([sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) 0.0.79,
adapted from pi's example sandbox extension): no network, writes only under
`scratch/`, reads only the work folder and the interpreter's own folders (on macOS and
Linux everything outside the home folder stays readable). Before the first document,
a probe checks in the sandbox that the interpreter imports numpy and Pillow, that it
can write to `scratch/` and nowhere else, and that a network connection fails; if
the sandbox is missing or leaks, the run stops with exit code 2. On Windows the
sandbox needs a one-time setup with administrator rights:

```powershell
npx @anthropic-ai/sandbox-runtime@0.0.79 windows-install
```

It creates a local account `srt-sandbox`, under which the scripts run, and a Windows
Filtering Platform rule that blocks that account's outbound connections
(`windows-uninstall` removes both). The grants are permissions for that account on the
work folder and the interpreter, added while a run uses them. Limits: DNS lookups still
go through the system resolver, folders that every local user may read stay readable,
and two Mabillon processes running python at the same time share the account and thus
each other's grants. `--no-python-sandbox` (`python_sandbox: false`) runs the scripts
unsandboxed with your user's permissions. Mabillon itself never follows a link or
junction the script puts into `scratch/` when it writes the script, clears or reads
`scratch/show/`.

`read`, `write`, and `edit` are confined to the agent's work folder. `bash` is not
sandboxed: it runs with your user's permissions. Mabillon keeps its canonical
copies outside the agent's reach and restores committed units that were changed
afterwards, but it is off by default; enable it only for trusted inputs.

`bash` uses pi's shell. On Windows pi looks for Git Bash under `Program Files` and
for `bash.exe` on `PATH`; Mabillon also tries a per-user Git install
(`%LOCALAPPDATA%\Programs\Git`). Another shell can be set with `shellPath` in pi's
`settings.json` (`~/.pi/agent`). When `bash` is requested but no shell is found,
the run stops before touching any document (exit code 2). Every bash command runs with
`PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` (and `LC_ALL=C.UTF-8` on Windows), and a
unit file that is not valid UTF-8 fails `verify` with an error.

### Unit protocol and its enforcement

The system prompt's method has the agent check its draft against the page
systematically: with `view` (or `python`), it goes through the whole page in
overlapping bands, magnified only as far as needed to make every character
unambiguous, and corrects the draft band by band (extraction: compares the entries of
each band field by field and adds missing ones). The prompt ends with the completion
condition shared by the prompting guides of the Claude 5.5, GPT-6, Qwen and Kimi
models: a unit is done when its file covers the page, every reading is checked and
`verify` reports no errors; until then the agent keeps working instead of ending its
turn with a summary or question, runs `verify` after its last change, and marks what
the source cannot settle instead of guessing.

The system prompt tells the agent to finish one unit before anything else, and the
harness enforces it:

- The next unit is delivered only after a passing `verify` with `final=true`. Calls
  that try to touch later pages or chunks are blocked.
- `write` and `edit` are limited to the current unit's file, `notes.md`, and
  `scratch/`. Committed units are final.
- Each unit has a tool budget per session. After `tool_soft_cap` calls (default 30)
  only `write`, `edit`, `verify`, and reading the unit's own file remain. After
  `tool_hard_cap` calls (default 40) the unit is closed as `needs_review` with its
  current file and the next unit follows. Calls that fail argument validation count
  as well.
- If the agent stops before its units are committed, it is told to continue (up to
  `settle_retries` times, default 3). A fresh session then gets one more attempt at
  the unit; if the agent stops again, the unit is closed for review.

Safeguards on the document level: three consecutive units closed for review stop the
document with an error (check the model, schema, and context, then rerun with
`--redo-review`). Transient provider errors (rate limits, overload, network) are
retried with increasing waits of 15 s to 2 min (1 to 15 min under `--service-tier
flex`), on top of pi's own retries, and the
count starts afresh whenever a session makes progress. Rejected credentials and
exhausted quotas or subscription usage limits stop the whole run (per-minute quotas
that ask for a short wait count as transient).

### Compaction

When the context exceeds `compact_at_tokens` (default 250,000), it is compacted at the
next unit boundary, never in the middle of a page. The threshold is lowered when
needed to leave room below the model's context window for a whole unit of work (the
window minus pi's reserve of 16,384 tokens minus 20% of the window, at least 24,000
tokens). `compact_at_tokens: 0` compacts at every boundary.

Compaction does not call the model: the conversation is replaced by a deterministic
state summary (progress, `notes.md`, the end of the last committed unit), and the
context images and the next unit follow. Because every unit is committed to disk
before the boundary, no work is lost. If a single unit ever overflows the context
window, pi's own compaction runs with the same summary and the unit is shown again.

To keep requests small, page images of committed units are removed from later
requests (the agent can view them again), and within a unit the oldest views are
dropped first when a provider's per-request image limits would be exceeded.

### Image fidelity

Page images are rendered, cropped, and encoded by Mabillon itself (one JPEG encode
at quality 90 with full chroma, from lossless data) and sent at the largest size the
model accepts, with the provider parameter that makes the provider look at them at
full resolution (`--image-quality max`, the default):

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

Open-weight models have no request parameter for image detail: the image processor
of the host decides, and these limits follow the published processor configurations
of the models. Their processors round image sizes to their token grid, which
resamples the image, so Mabillon pads images with white at the right and bottom
to a multiple of the grid (32 px for Qwen and Nemotron, 28 px for Kimi, GLM and
Mistral, 48 px for Gemma, 42 px for DeepSeek, whole 336 px tiles for Llama 4)
instead; the agent is told the size of the padding. `--image-quality high` uses
2,560 tokens for Qwen (Alibaba's default of 2.62 MP), 4K (4,096 px, 8.8 MP) for
Kimi, as Moonshot recommends, 4,096 tokens for GLM and 560 tokens for Gemma; the
other families have a single tier. MiniMax M3 and Muse Glimmer keep the generic
limits until their published processor settings are confirmed. A host that rejects
an image falls back from max to high to standard; each lower tier keeps the
family's token grid and never exceeds the tier above it. A host may downscale large
images on its own; the zoomed views keep fine print legible in that case too.

`--image-quality high` uses the cheaper high-detail modes, `standard` pi's defaults
(2,000 px). `--max-image-px` lowers the edge limit further; it never raises it above
the model's limit. If a provider rejects the image parameters, Mabillon falls back
one level for that document and retries the session; each downgrade is recorded
(`image_fallbacks` in the metadata), and `--no-image-fallback` fails the document
instead. Zoomed regions are cut from the full-resolution
page, so small type stays legible even where full-page views are downscaled; the
agent is told when a view is downscaled. For PDFs the full-resolution page is the
page as rendered at `--dpi` (capped by `max_render_pixels`), so raise `--dpi` for
high-resolution scans. Higher fidelity costs more input tokens.

PDF pages are rendered at `--dpi` (default 300, at most `max_render_pixels`, default
30 MP). Image files are decoded at most at 100 MP (larger scans are reduced on load);
files above 1,000 MP are refused. In `mabillon tui`, pi resizes tool images to
2,000 px unless image auto-resize is turned off in `/settings` (the TUI reminds you at
start).

### Text chunks

Text documents are cut into chunks of about `chunk_tokens` tokens at the best nearby
boundary: a heading, a title after a blank line, a paragraph break, or at least a
sentence end (never before a line that continues a sentence when a better cut
exists). Overlong lines are split without changing the line numbering. HTML, DOCX, and
EPUB are converted to Markdown without escaping the text; tables become pipe tables
with empty cells kept, lines within a cell separated by `<br>`, and captions above the
table; superscripts and subscripts stay marked (`<sup>`,
`<sub>`); merged cells (`colspan`, `rowspan`) leave empty cells so the other values
keep their columns, and DOCX conversion messages are reported as warnings. Line
numbers are those of the converted text (`run/text/document.txt`,
identical to the file for .txt and .md inputs). Legacy encodings (Windows-1252,
UTF-16 without byte order mark, stray legacy bytes in UTF-8) are detected. A
ChronoMiner `<stem>_line_ranges.txt` next to a .txt or .md input (for example after
ChronoMiner's semantic boundary adjustment) is used instead of automatic chunking;
ranges out of order or overlapping fail the document, and so do source lines in no
range, unless `--allow-partial-ranges` accepts them (the uncovered lines are then
listed as `uncovered_lines` in the metadata). Transcripts made by
Mabillon or ChronoTranscriber are preferably cut at their page separators.

Each chunk is delivered with the last lines of the previous chunk and the first lines
of the next as marked context. An entry belongs to the chunk where it begins; when it
continues, the agent may read up to two chunks ahead to complete it and leaves a
carry-over note so the next chunks skip the continuation. Pages work the same way
with the previous and next page.

### Verification

`verify` checks, in this order:

1. parsing: YAML front matter and body for transcription units, JSON for extraction
   units, with line and column for syntax errors;
2. the full JSON Schema (Draft 2020-12) of the selected schema, not just the subset
   that providers enforce in strict mode;
3. consistency rules: transcription flags against the body, the
   `contains_no_content_of_requested_type` flag against `entries`, and marker syntax
   (`<page_number>`, `<unclear>`, `<gap/>`, footnotes; other tags only if the
   description of the schema's body field names them);
4. quality: schema text or tool markup leaking into values, generation loops,
   repeated lines;
5. grounding (text sources only): fields listed as verbatim in the schema's rules
   file should occur in the source text (word trigram coverage, tolerant of ſ,
   ligatures, and line-end hyphenation). A field whose share of trigrams found in the
   source is below `--grounding-threshold` (default 0.8) gets a warning, not an error.
   When the verbatim fields of all entries together cover less than half of the
   words of the unit's own chunk (chunks of 300 characters or more), a warning points
   to possibly missing entries, and the first `verify final=true` with this warning is
   refused (a second call commits the unit with the warning kept);
6. process: the unit's page or text must be in the current context when committing.
   An extraction unit without entries is committed only after a second
   `verify final=true` in a later turn, with a warning, when a draft of the same
   session had entries or when the unit is a page or a chunk of 300 characters or
   more.

Errors block the commit; warnings are recorded with the unit and in the outputs. The
same checks are available without a model via `mabillon verify`, which also reads
the schema recorded next to Mabillon outputs and applies the unit checks to every
page of an exported transcription `<stem>.json`. The recorded schema takes precedence
over a `schema:` in `mabillon.yaml`; only `--schema` on the command line overrides
it. A file that is not valid UTF-8 fails with an error.

## Outputs

Transcription (`mabillon_output/<stem>/`):

- `<stem>.json`: `{mabillon: {...run metadata...}, pages: [...]}`. Each page holds
  the schema fields plus `unit`, `status`, `page`, and the source image or PDF page.
- `<stem>.md`: the transcriptions in page order, each page introduced by
  `<!-- page N (pNNNN) -->` (with "needs review" where applicable).

Extraction:

- `<stem>.json`: one object in the shape of the extraction schema: the entries of all
  units concatenated in document order; other top-level fields take the first
  non-null value of any unit.
- `<stem>.provenance.json`: run metadata (model, tokens, cost, units needing review),
  the unit (page or line range) of every entry, and per-unit status, entry counts,
  top-level field values, and carry-over notes. If the merged object does not
  validate against the schema (for example because a unit closed for review is
  invalid), the errors are listed under `final_validation`.
- Top-level fields that change from unit to unit, such as the running city heading of
  a guide (a field such as `active_city_or_town`), cannot be represented in the
  merged object. They are listed under `mabillon.varying_fields`, and every
  provenance entry carries its unit's values in `unit_fields`; join the two files on
  the entry index to use them.

The run metadata has `complete` (every unit of the document finished) and, for runs
limited with `--units`, `selection` with the IDs and state of the selected units.
It records the run so that experiment arms are self-describing: `implementation`
(package version, and the git commit and uncommitted changes of a checkout),
`experiment` (tool set, resolved settings, context file hashes, boundary policy,
system-prompt hash), `session_settings` (model, thinking, tools and image profile
per session, for OpenRouter the routing preferences and the upstream providers
that served the session, and the OpenAI service tier where one was requested),
`image_fallbacks`, `uncovered_lines`, and the units shaped
by the tool budget (`units_closed_by_hard_cap`, `units_with_soft_cap_blocks`; per unit
`hard_cap_closed`, `soft_cap_blocks` and the committing `session`). Each page
(transcription) or provenance unit record lists its remaining verification issues
under `issues`, and the metadata counts them (`warnings`, `units_with_warnings`). A
finished unit whose committed copy is missing or was changed is not exported: its
record has `integrity_error`, and the next run reopens and redoes it.

Working files: `work/` is the agent's workspace (`units/`, `notes.md`, `scratch/`,
and text chunks in `source/`); `run/` holds Mabillon's own state (`state.json`,
the canonical committed units in `committed/`, the converted text, and the pi session
logs in `sessions/`, with page images removed unless `--keep-session-images`).

## Schemas

Bundled schemas live in `schemas/`:

- `transcription/diplomatic_markdown_transcription.json` (default): diplomatic
  transcription with markdown structure, `<page_number>`, footnotes,
  `![Image: ...]`, and the uncertainty markers `<unclear>...</unclear>` and `<gap/>`;
- copies of three ChronoTranscriber transcription schemas;
- no extraction schemas in this public snapshot; pass them with `--schemas-dir`.

`mabillon schemas` lists them together with any schema file that could not be
loaded and the reason (`load_errors` with `--json`).

`--schema` accepts a schema name, a file stem, or a path. `--schemas-dir` adds
directories (they shadow bundled schemas of the same name). A schema can be either a
wrapper `{name, strict, schema}` or a bare JSON Schema.

Optional rules files sit in a `rules/` folder next to the schema (or in
`schemas/rules/` of this package) and are named `<schema name>.rules.json`:

```json
{
  "verbatimFields": ["recipe_text_original", "title_original"],
  "bodyField": "transcription"
}
```

`verbatimFields` are entry fields checked against the source text; `bodyField` is the
field of a transcription schema that receives the Markdown body of a unit file.
`boundary` sets how extraction treats entries that cross a unit boundary:
`"complete"` (default) records the whole entry in the unit where it begins, reading
ahead and passing a carry-over note; `"fragments"` records each unit's part as its
own entry flagged as a fragment. Without the key, a schema whose entries have a
boolean field with "fragment" in its name (such as `entry_is_fragment`) uses `"fragments"`.

Extraction schemas must have a top-level `entries` array (optionally with
`contains_no_content_of_requested_type` and other top-level fields), since the
outputs concatenate the entries of all units; other extraction schemas are refused
at the start of a run. A user schema that fails to load is reported as an error
instead of falling back to a bundled schema of the same name.

For doubtful readings, the transcription prompt follows the schema's own instruction
when the description of its body field has one (for example a rule for uncertain or
illegible text); otherwise the agent uses `<unclear>...</unclear>` and `<gap/>`.

## Context

Context about the source (type, language, hand, typeface, conventions) improves
results. Text context goes into the system prompt; context images are attached to the
first message of every session and again after each compaction.

- `--context notes.md` and `--context-image sample.png` apply to every document (both
  repeatable; context text must be .md, .markdown, or .txt).
- Picked up automatically, from general to specific: `context.md|txt` and
  `context*.png|jpg|...` in the folder containing the document; for image folders,
  the same files inside the folder; and `<stem>.context.md` and `<stem>.context*.png`
  next to the document. `--no-auto-context` turns this off.

## Use from Claude Code and other agents

Mabillon runs headless, like `codex exec`: it never prompts, prints one
machine-readable JSON result on stdout with `--json` (progress goes to stderr, or
nowhere with `--quiet`), and uses stable exit codes:

| Code | Meaning |
| --- | --- |
| 0 | every selected unit committed |
| 1 | incomplete or failed documents (or `verify` found errors) |
| 2 | usage, configuration, or credential error |
| 3 | finished, but some units were closed for human review |
| 130 | interrupted (state is saved; rerun the same command to resume) |

`mabillon status` exits with 1 when it finds no runs and with 2 when the path does
not exist. Without a path it reads the output folder set by `out:` in
`mabillon.yaml` or `--out`. Finished units whose committed copy is missing or was
changed are listed as `units_damaged`; they count as pending, so the document is not
`complete`. The outcome of the last export is kept in the state: a merged output that
fails the schema (`final_validation`) or a failed export (`export_error`) also makes
the document not `complete`, as does an export that no longer matches the unit state
or whose files are gone (`incomplete_reason: "export missing or stale"`).

```bash
mabillon transcribe scans/ --json --quiet --units 1-3
mabillon status mabillon_output/ --json
mabillon verify mabillon_output/scans/scans.json --json
```

Every JSON result has `ok` and `exit_code`. Run results list each document with
`status` (`complete`, `needs_review`, `incomplete`, `failed`), output paths, unit
counts, `units_needs_review` with reasons, cost, `warnings` (encoding problems,
line-range gaps), and `error` when something failed. A document without any text, or
a `--units` selection that matches none of its units, is reported as failed.

`integrations/claude-code/mabillon/SKILL.md` is a ready-made Claude Code skill.
Copy it to `~/.claude/skills/mabillon/` (or `.claude/skills/mabillon/` in a
project) and allow `Bash(mabillon:*)` so Claude Code can start runs, run long ones
in the background, poll `status`, and read the outputs.

## Interactive mode

`mabillon tui` starts pi's interactive terminal UI with two extra tools: `view`
(any image, PDF page, or TIFF page, with zoom) and `verify` (any file against any
schema). It reads `mabillon.yaml` from the working directory. Use it to log in, to
try models on difficult pages, or to develop context and schemas.

## Development

```bash
npm run check    # biome lint/format check + TypeScript
npm run format   # apply biome fixes
npm test         # unit tests and end-to-end runs against a scripted faux model
npm run build
```

The end-to-end tests drive the real pi agent loop with a scripted model and cover
the unit gate, tool budgets, nudges, compaction, session handoff, PDF rendering,
provider errors, resume checks, and extraction with grounding and carry-over.

## Versioning

Mabillon follows semantic versioning; release notes are in
[CHANGELOG.md](CHANGELOG.md).

## License

MIT
