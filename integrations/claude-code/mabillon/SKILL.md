---
name: mabillon
description: Transcribe historical PDFs or page scans, or extract schema-validated JSON records (recipes, bibliographic entries, address books, prices, ...) from PDFs, images, or text files, by running the Mabillon CLI. Use when the user asks to transcribe a scanned document or book, to extract structured data from a historical source, or to validate output against a ChronoMiner/ChronoTranscriber schema.
---

# Mabillon

Mabillon is a command-line agent (built on pi) that works through a document page
by page or chunk by chunk, zooms into page images, and validates every unit against a
JSON schema before moving on. Call it through Bash; it runs headless and never
prompts.

## Commands

```bash
mabillon transcribe <pdf|image|folder>... --json --quiet [--model provider/id] [--thinking medium]
mabillon extract <pdf|image|folder|text file>... --schema <name|path> --json --quiet [--model provider/id]
mabillon status [output dir] --json         # progress of running or finished runs (no model call)
mabillon verify <file> [--schema <name>] --json   # validate any output file (no model call)
mabillon schemas --json                     # list available schemas
```

- If `mabillon` is not on PATH (the repository was not `npm link`ed), call
  `node <repo>/dist/bin.js` with the same arguments.
- Models are `provider/id`; the ChatGPT subscription login is provider `openai`
  (e.g. `--model openai/gpt-6-luna`).
- Always pass `--json` (one JSON result on stdout) and `--quiet` (no progress on
  stderr) when you call it. Every JSON result has `ok` and `exit_code`.
- Exit codes: 0 every selected unit committed; 1 incomplete or failed documents (or
  verify errors); 2 usage, configuration, or credential error; 3 finished, but some
  units were closed for human review; 130 interrupted. Rerunning the same command
  resumes from the last committed unit.
- Outputs go beside each input or under `--out <dir>` (`--layout`, `--formats`):
  `<name>.txt` (and `<name>.md` with `--formats txt,md`) for a transcription;
  `<stem>_output.json`, one object in the schema's shape with the entries of the
  committed units (and `<stem>_output.csv` with `--formats json,csv`), for an
  extraction. Each document also gets a sidecar (`<name>.mabillon.json`, for
  extractions `<stem>_output.mabillon.json`) with run metadata, per-page objects or
  the merged extraction including drafts closed for review. Working files go to
  `<output root>/.mabillon/`. The `--json` result lists the exact paths per
  document, with `status` (`complete`, `needs_review`, `incomplete`, `failed`).
- `--chrono` writes ChronoTranscriber's or ChronoMiner's files and SQLite store
  instead, so those tools can render, repair and resume the documents. Pass it only
  when the user works with those tools. A run resumes only with the setting it
  started with, and a run without `--chrono` refuses an output root that holds a
  `chronotranscriber.sqlite` (transcription) or `chronominer.sqlite` (extraction).
- Useful options: `--units 1-20` (page/chunk selection), `--units-per-session 20`,
  `--image-quality max|high|standard`, `--context notes.md`,
  `--context-image sample.png`, `--force` (start over), `--redo-review`,
  `--tools read,write,verify` (exact tool set; bash is off unless `--bash`).
- OpenRouter models (`--model openrouter/qwen/qwen3.8-27b`) use zero-data-retention
  endpoints only, unless `--no-zdr` is given; `--openrouter-providers deepinfra`
  pins the upstream provider. Exit code 2 with "no endpoint" means no endpoint
  meets these settings.

## How to use it well

1. Runs are long (minutes per page with strong models). For more than a few pages,
   start the command in the background and check progress with
   `mabillon status <out dir> --json` (it reports `running` while a process holds
   the document) instead of waiting.
2. Start with a small selection (`--units 1-3`) to check quality and cost before a
   full run. Later runs without `--units` continue with the remaining pages.
3. Transcribe first, then extract from the transcript:
   `mabillon extract <name>.txt --schema <name>` (the path the transcription's
   `--json` result lists).
4. Give context when you know it (language, period, typeface or hand, layout
   conventions): write it to a .md file and pass `--context`, or place
   `<stem>.context.md` next to the input.
5. Units listed under `units_needs_review` were closed without a passing
   verification (the reason is given); report them to the user rather than
   presenting the output as clean. Pass on any `warnings` (encoding problems, gaps in
   line ranges). In extractions, check `final_validation` in the sidecar's
   `mabillon` metadata; fields listed under `varying_fields` (e.g. a page's city
   heading) are per entry in the sidecar's `entries[].unit_fields`, not in `merged`.
6. The model and credentials come from pi's configuration (`~/.pi/agent`). If the
   result says no model is available or the credentials were rejected (exit code 2),
   ask the user to run `mabillon tui` and `/login`, or to pass `--model`.
7. Do not run two commands on the same document at once; the second one fails with a
   lock message. With `--chrono`, a document that ChronoTranscriber or ChronoMiner is
   working on in the same store is refused while that run holds its lease.

## Permissions

To let Claude Code run it without prompting, allow `Bash(mabillon:*)` in the
project's `.claude/settings.json` (or `Bash(node <repo>/dist/bin.js:*)` when it is
not linked).
