# Mabillon v0.12.0

<img src="assets/logo.svg" alt="Mabillon logo" width="64" align="right">

Mabillon is an agent for transcribing historical sources and extracting
schema-validated structured data from them. It is named after Jean Mabillon
(1632-1707), whose *De re diplomatica* founded the critical study of documents. It is
built on the [pi](https://github.com/earendil-works/pi) agent harness and uses the
JSON schema format of ChronoTranscriber and ChronoMiner. It runs on its own; with
`--chrono` it also writes the files and SQLite stores of those two tools, so that they
can render, repair and resume its documents.

Instead of one model call per page, a single agent works through a document page by
page (or chunk by chunk) with a small tool set. It looks at the page, writes its
transcription or extraction to a file, zooms into difficult regions, re-reads and
corrects. Before the next page or chunk is delivered, the `verify` tool must accept the
file. Runs are resumable, and output quality scales with the model and its reasoning
effort.

Status: beta. The harness is covered by end-to-end tests against a scripted model;
transcription quality has to be judged on your own material.

## Installation

Requires Node.js 22.19 or newer.

```bash
git clone https://github.com/Paullllllllllllllllll/Mabillon.git
cd Mabillon
npm install        # also builds dist/ via the prepare script
npm link           # makes `mabillon` available on your PATH (optional)
```

Credentials and model settings are shared with pi (`~/.pi/agent/auth.json`). If you
already use pi, nothing else is needed. Otherwise log in once through the interactive
mode:

```bash
mabillon tui        # then type /login and pick a provider (e.g. ChatGPT, Claude, Gemini)
```

API keys in the usual environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, ...) work as well. Models are named
`<provider>/<id>`, for example `openai/gpt-6-luna` or `openrouter/qwen/qwen3.8-27b`.
[docs/providers.md](docs/providers.md) covers model names, OpenRouter data retention
and provider pinning, and OpenAI service tiers.

## Usage

```bash
# Transcribe a PDF (default schema: diplomatic_markdown_transcription)
mabillon transcribe book.pdf --model openai/gpt-6-luna --thinking medium

# Transcribe a folder of page scans, 20 pages per agent session
mabillon transcribe scans/book_1747/ --units-per-session 20

# Extract price-list entries from the transcription produced above (book.txt beside book.pdf)
mabillon extract book.txt --schema PriceListEntries --formats json,csv

# Extract catalogue records directly from page images, first 40 pages only, into out/
mabillon extract catalogue.pdf --schema BibliographicCatalogueEntries --units 1-40 --out out

# Write ChronoTranscriber's files and store, so that the tool can render and resume the document
mabillon transcribe book.pdf --chrono

# Validate any file against a schema (no model involved)
mabillon verify book.mabillon.json
mabillon verify entries.json --schema BibliographicCatalogueEntries --source catalogue.docx

# List bundled and user schemas
mabillon schemas

# Progress of runs (reads their state; no model involved)
mabillon status out/
```

`mabillon tui` starts pi's interactive terminal UI with two extra tools: `view` (any
image, PDF page, or TIFF page, with zoom) and `verify` (any file against any schema).
It reads `mabillon.yaml` from the working directory. Use it to log in, to try models on
difficult pages, or to develop context and schemas.

## Modes

| Mode | Input | Unit | Output |
| --- | --- | --- | --- |
| `transcribe` | PDFs, image folders, single images, multi-page TIFFs | page | `.txt` (and `.md`), from pages validated against a transcription schema |
| `extract` | PDFs and images (read as images; any text layer is ignored) | page | `_output.json` (and `_output.csv`), from entries validated against an extraction schema |
| `extract` | text: .txt, .md, .csv, .tsv, .json, .xml/TEI, .html, .docx, .epub | chunk (about 2,500 tokens, cut at semantic boundaries between lines) | same |

The modes are separate on purpose. To extract from your own transcriptions, run
`transcribe` first and then `extract` on the resulting `.txt` or `.md` file.

## Outputs

Without `--out`, outputs go beside each input; with `--out`, under that folder, placed
by `--layout`. A transcription writes `<name>.txt` (and `<name>.md` with
`--formats txt,md`). An extraction writes `<stem>_output.json`, one object in the shape
of the extraction schema with the entries of all committed units (and
`<stem>_output.csv`, one row per entry, with `--formats json,csv`). Beside them, each
document gets a sidecar, `<name>.mabillon.json` or `<stem>_output.mabillon.json`, with
the per-unit status, the drafts of units closed for review, and the run metadata.
Working files live in `<output root>/.mabillon/<name>/`.

By default, Mabillon touches no ChronoTranscriber or ChronoMiner store, and it refuses
an output root that holds one. With `--chrono` (`chrono: true`), it writes into
`chronotranscriber.sqlite` or `chronominer.sqlite`, renders the files exactly as the
tool's own `render` command would, and adopts units that the tool finished. A run
resumes only with the setting it started with. [docs/outputs.md](docs/outputs.md)
describes the files and the sidecar, [docs/chrono.md](docs/chrono.md) the store
handling and the correction mode (`--drafts`), which corrects the units of an earlier
ChronoTranscriber or ChronoMiner run.

## Configuration

`mabillon --help` lists every option. All options except `--json`, `--quiet`,
`--config`, and `--source` can also be set in a `mabillon.yaml` in the working
directory (or `--config file`), using the option names in snake_case or camelCase.
Relative paths in the file are resolved against the file's folder.

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

Values are checked before any document is touched (exit code 2 on errors).
`grounding_threshold` must lie in (0, 1] and use a decimal point (`0.8`, not `0,8`).
Counts and sizes such as `units_per_session`, `dpi`, or `chunk_tokens` must be at
least 1, and `tool_soft_cap` may not exceed `tool_hard_cap` (it is not raised
silently).

## Schemas

Schemas use the format of ChronoTranscriber and ChronoMiner: `{name, strict, schema}`
wrappers or bare JSON Schemas, with the
`{contains_no_content_of_requested_type, entries}` envelope for extraction. The package
bundles a default transcription schema, copies of the tools' transcription schemas,
and ChronoMiner's example extraction schemas. `--schema` selects one by name, file stem
or path, and `--schemas-dir` adds your own. `mabillon schemas` lists them. See
[docs/schemas.md](docs/schemas.md) for rules files and the requirements on extraction
schemas.

## Context

Context about the source (type, language, hand, typeface, conventions) improves
results. Text context goes into the system prompt; context images are attached to the
first message of every session and again after each compaction.

- `--context notes.md` and `--context-image sample.png` apply to every document (both
  repeatable; context text must be .md, .markdown, or .txt).
- Picked up automatically, from general to specific: `context.md|txt` and
  `context*.png|jpg|...` in the folder containing the document (for an image folder,
  the folder beside it; images inside an image folder are always pages);
  `<stem>.context.md` and `<stem>.context*.png` next to the document; and the context
  sidecar the Chrono tool would read: ChronoTranscriber's `<name>_transcr_context.txt`
  and `<name>_transcr_context_image.*` for `transcribe`, ChronoMiner's
  `<stem>_extract_context.txt|png|...` for `extract`, each beside the input or, as in
  the tool, beside its folder. `--no-auto-context` turns this off.

## Use from Claude Code and other agents

Mabillon runs headless, like `codex exec`. It never prompts, prints one
machine-readable JSON result on stdout with `--json` (progress goes to stderr, or
nowhere with `--quiet`), and uses stable exit codes:

| Code | Meaning |
| --- | --- |
| 0 | every selected unit committed |
| 1 | incomplete or failed documents (or `verify` found errors) |
| 2 | usage, configuration, or credential error |
| 3 | finished, but some units were closed for human review |
| 130 | interrupted (state is saved; rerun the same command to resume) |

```bash
mabillon transcribe scans/ --json --quiet --units 1-3
mabillon status . --json
mabillon verify scans.mabillon.json --json
```

[docs/runs.md](docs/runs.md) lists the fields of the JSON results and the exit codes of
`mabillon status`. `integrations/claude-code/mabillon/SKILL.md` is a ready-made Claude
Code skill. Copy it to `~/.claude/skills/mabillon/` (or `.claude/skills/mabillon/` in a
project) and allow `Bash(mabillon:*)` so that Claude Code can start runs, run long ones
in the background, poll `status`, and read the outputs.

## Documentation

- [docs/runs.md](docs/runs.md): documents, working folders, sessions, resume, the unit
  protocol, safeguards, compaction, text chunks, status and JSON results.
- [docs/tools.md](docs/tools.md): the agent's tools, tool sets, the python sandbox and
  bash.
- [docs/images.md](docs/images.md): image fidelity per provider, padding, quality
  tiers, fallbacks, resolution limits.
- [docs/verification.md](docs/verification.md): the checks of `verify` and
  `mabillon verify`.
- [docs/schemas.md](docs/schemas.md): bundled schemas, rules files, requirements on
  extraction schemas.
- [docs/outputs.md](docs/outputs.md): output files, the sidecar, run metadata, working
  files.
- [docs/chrono.md](docs/chrono.md): `--chrono`, the stores, adoption, correction mode,
  the interop check.
- [docs/providers.md](docs/providers.md): models, credentials, OpenRouter, OpenAI
  service tiers.

## Development

```bash
npm run check    # biome lint/format check + TypeScript
npm run format   # apply biome fixes
npm test         # unit tests and end-to-end runs against a scripted faux model
npm run build
```

The end-to-end tests drive the real pi agent loop with a scripted model and cover the
unit gate, tool budgets, nudges, compaction, session handoff, PDF rendering, provider
errors, resume checks, and extraction with grounding and carry-over. Mabillon pins
`@earendil-works/pi-coding-agent` at 1.5.0. The check of the outputs against the Chrono
tools' own code is described in [docs/chrono.md](docs/chrono.md#interop-check).

## Versioning

Mabillon follows semantic versioning; release notes are in
[CHANGELOG.md](CHANGELOG.md).

## Contact

Mabillon is written and maintained by Paul Götz, Sociological Institute,
University of Zurich. Write to
[goetz@soziologie.uzh.ch](mailto:goetz@soziologie.uzh.ch) with questions, bug
reports or collaboration requests.

- Website: [paulgoetz.org](https://paulgoetz.org)
- Google Scholar: [Paul Götz](https://scholar.google.com/citations?user=V9WRFP4AAAAJ)
- ORCID: [0009-0005-9431-0900](https://orcid.org/0009-0005-9431-0900)
- LinkedIn: [paulg3737](https://www.linkedin.com/in/paulg3737)
- UZH: [institute profile](https://www.suz.uzh.ch/en/institute/aboutus/mid_level/goetz.html)

## License

MIT
