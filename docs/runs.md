# How a run works

A run resolves its inputs into documents, splits each document into units, and has
one agent work through the units in order. This page describes the documents, the
working folders, sessions and resume, the unit protocol, the safeguards, compaction,
and text chunks. For the agent's tools see [tools.md](tools.md), for the checks
behind the gate see [verification.md](verification.md).

## Documents

Mabillon resolves each input into documents:

- A folder that directly contains images (other than context images) is one
  document. Its pages are all the images ChronoTranscriber would list, in natural
  sort order with the file name as tie-break, hidden files included.
- A page in a format Mabillon cannot decode (BMP, JPEG 2000, PNM) refuses the
  document, and the message names the file.
- Each page of a multi-page TIFF is a unit. Directories that the file marks as
  reduced-resolution copies, such as pyramid levels and thumbnails, are skipped.
- PDFs and text files in the same folder are separate documents.
- Subfolders are searched the same way, up to eight levels. Hidden folders,
  `.mabillon` working folders, the `--out` folder, and the files and stores of the
  Chrono tools are skipped.

Three cases are refused before any agent work:

- Documents whose rendered files or sidecars would share a path, in both modes. This
  includes names that differ only in case.
- With `--chrono`, also two images of one folder in extraction, because each image is
  its own ChronoMiner document and their outputs would share a file name.
- A text with a line longer than four chunks (`chunk_tokens` at four characters per
  token), because chunks keep whole lines.

## Outputs and working folders

The outputs of each document go beside the input or under `--out`, with the names
and layouts described in [outputs.md](outputs.md). The working files go to
`.mabillon/<name>/` in the same output root. For a transcription, `<name>` is the
document name. For an extraction it is the ChronoMiner name with `_output`, for
example `.mabillon/book/` and `.mabillon/book_output/`. An image folder takes its
mirrored path, such as `.mabillon/A/scan_output/`. The two commands therefore never
share working files.

## Units and sessions

1. The document is split into units: pages `p0001, p0002, ...` (PDF pages are
   rendered at 300 DPI on demand) or text chunks `c0001, ...`.
2. One agent session handles up to `units_per_session` units (default 20). When it
   is done, a fresh session continues with the next units. It receives a handoff
   made of the agent's `notes.md`, the end of the previous unit, and any carry-over
   note.
3. Within a session, the agent receives one unit at a time and must commit it
   before the next one is delivered.
4. After every session, the final outputs are assembled from the committed units.

## Resume

An interrupted run resumes from the last committed unit when the same command is run
again. `--force` starts over. `--redo-review` re-runs units that were closed for
review, within the `--units` selection if one is given. Only one process can work on
a document at a time.

A run is resumed only with the `--chrono` setting it was started with. A resume with
the other setting is refused before anything changes, with a message to rerun with (or
without) `--chrono` or to start over with `--force`. Runs started with Mabillon 0.10.0
or 0.11.0 count as `--chrono` runs.

A run also refuses to resume when any of these changed in the meantime:

- the source,
- the schema or its rules file (line endings of the schema file do not count),
- the chunking,
- the experiment arm: the tool set, the context files, the system prompt, and the
  settings that shape the agent's work (caps, units per session, compaction,
  grounding threshold, image settings, chunking, fallback and line-range options).

The model and the thinking level may change. Each unit records the session that
committed it. A run from before experiment records resumes only if the agent never
worked on it, that is, if it has no sessions, drafts, notes or finished units. A
refused resume changes neither the state nor the outputs.

## Unit protocol and its enforcement

The system prompt gives the agent a method for checking its draft against the page.
With `view` (or `python`), the agent goes through the whole page in overlapping
bands. It magnifies only as far as needed to make every character unambiguous, and
it corrects the draft band by band. In extraction, it compares the entries of each
band field by field and adds missing ones.

The prompt ends with a completion condition that the prompting guides of the Claude
5.5, GPT-6, Qwen and Kimi models share. A unit is done when its file covers the page,
every reading is checked, and `verify` reports no errors. Until then the agent keeps
working instead of ending its turn with a summary or a question. It runs `verify`
after its last change and marks what the source cannot settle instead of guessing.

The prompt tells the agent to finish one unit before anything else, and the harness
enforces this:

- The next unit is delivered only after a passing `verify` with `final=true`. Calls
  that try to touch later pages or chunks are blocked.
- `write` and `edit` are limited to the current unit's file, `notes.md`, and
  `scratch/`. Committed units are final.
- Each unit has a tool budget per session. After `tool_soft_cap` calls (default 30),
  only `write`, `edit`, `verify`, and reading the unit's own file remain. After
  `tool_hard_cap` calls (default 40), the unit is closed as `needs_review` with its
  current file, and the next unit follows. Calls that fail argument validation count
  as well.
- If the agent stops before its units are committed, it is told to continue, up to
  `settle_retries` times (default 3). A fresh session then gets one more attempt at
  the unit. If the agent stops again, the unit is closed for review.

## Document-level safeguards and retries

Three consecutive units closed for review stop the document with an error. Check the
model, the schema and the context, then rerun with `--redo-review`.

Transient provider errors (rate limits, overload, network) are retried on top of
pi's own retries. The waits increase from 15 s to 2 min, or from 1 to 15 min under
`--service-tier flex`. The count starts afresh whenever a session makes progress.

Rejected credentials and exhausted quotas or subscription usage limits stop the whole
run. Per-minute quotas that ask for a short wait count as transient.

## Compaction

When the context exceeds `compact_at_tokens` (default 250,000), it is compacted at the
next unit boundary, never in the middle of a page. `compact_at_tokens: 0` compacts at
every boundary. The threshold is lowered when needed to leave room below the model's
context window for a whole unit of work. The room is the window minus pi's reserve of
16,384 tokens minus 20% of the window, and at least 24,000 tokens.

Compaction does not call the model. The conversation is replaced by a deterministic
state summary (progress, `notes.md`, the end of the last committed unit), and the
context images and the next unit follow. Every unit is committed to disk before the
boundary, so no work is lost. If a single unit ever overflows the context window,
pi's own compaction runs with the same summary and the unit is shown again.

To keep requests small, page images of committed units are removed from later
requests, and the agent can view them again. Within a unit, the oldest views are
dropped first when a provider's per-request image limits would be exceeded.

## Text chunks

Text documents are cut into chunks of about `chunk_tokens` tokens at the best nearby
boundary: a heading, a title after a blank line, a paragraph break, or at least a
sentence end. A cut never falls before a line that continues a sentence when a better
cut exists. A chunk always consists of whole lines, so a line longer than
`chunk_tokens` is a chunk of its own. ChronoMiner records each chunk as a line range.

Transcripts made by Mabillon or ChronoTranscriber are preferably cut at their page
separators. A ChronoMiner `<stem>_line_ranges.txt` next to a .txt or .md input (for
example after ChronoMiner's semantic boundary adjustment) is used instead of
automatic chunking. Ranges out of order or overlapping fail the document, and so do
source lines in no range. `--allow-partial-ranges` accepts uncovered lines and lists
them as `uncovered_lines` in the metadata.

HTML, DOCX, and EPUB are converted to Markdown without escaping the text:

- Tables become pipe tables with empty cells kept, lines within a cell separated by
  `<br>`, and captions above the table.
- Superscripts and subscripts stay marked (`<sup>`, `<sub>`).
- Merged cells (`colspan`, `rowspan`) leave empty cells, so the other values keep
  their columns.
- DOCX conversion messages are reported as warnings.

Line numbers are those of the converted text, stored as
`.mabillon/<stem>_output/run/text/<stem>.txt`; for .txt and .md inputs it is identical
to the file. With `--chrono`, ChronoMiner's store records this text as the input of a
converted document, and its stem keeps the document name when ChronoMiner resumes it.
Legacy encodings (Windows-1252, UTF-16 without byte order mark, stray legacy bytes in
UTF-8) are detected.

Each chunk is delivered with the last lines of the previous chunk and the first lines
of the next as marked context. An entry belongs to the chunk where it begins. When it
continues, the agent may read up to two chunks ahead to complete it, and it leaves a
carry-over note so that the next chunks skip the continuation. Pages work the same
way with the previous and the next page.

## Status and results

`mabillon status` reads the state of runs without a model. It finds the runs in the
`.mabillon` folders below the path. Without a path, it reads the output folder set by
`out:` in `mabillon.yaml` or by `--out`, else the current folder. It exits with 1 when
it finds no runs and with 2 when the path does not exist.

A document is not `complete` in these cases:

- Finished units whose committed copy is missing or was changed are listed as
  `units_damaged` and count as pending.
- The outcome of the last export, which the state keeps, is a merged output that
  fails the schema (`final_validation`) or a failed export (`export_error`).
- The export no longer matches the unit state or its files are gone
  (`incomplete_reason: "export missing or stale"`).

Every JSON result has `ok` and `exit_code`. A run result lists each document with
these fields:

- `status` (`complete`, `needs_review`, `incomplete`, `failed`),
- the output paths and the unit counts,
- `units_needs_review` with reasons, and the cost,
- `warnings` (encoding problems, line-range gaps),
- `error` when something failed.

A document without any text, or a `--units` selection that matches none of its
units, is reported as failed.
