# ChronoTranscriber and ChronoMiner compatibility

With `--chrono` (`chrono: true` in `mabillon.yaml`), Mabillon writes the files and the
store that ChronoTranscriber (`transcribe`) or ChronoMiner (`extract`) would write for
the same input and options. Either tool can then render, drop, repair, classify or
resume the documents. This page describes what the setting changes, the store
handling, the correction mode, and the interop check. `--no-chrono` turns the setting
off; it is off by default.

## What `--chrono` changes

Standalone mode, the default, opens no store and takes no leases, as
[outputs.md](outputs.md) describes, and it refuses an output root that holds the store
of its command. With `--chrono`, Mabillon works with the stores
`chronotranscriber.sqlite` (`transcribe`) and `chronominer.sqlite` (`extract`) in the
output root. The output root, the file names, `--layout` and `--formats` are the same
in both modes, and so are the sidecar and the working folders.

These parts are the same in both modes: the tools' context sidecars
(`<name>_transcr_context.txt`, `_extract_context`), ChronoMiner's
`<stem>_line_ranges.txt`, the discovery that skips the tools' files and stores, and
the schema format.

A run is resumed only with the setting it was started with. A resume with the other
setting is refused before anything changes, with a message to rerun with (or without)
`--chrono` or to start over with `--force`. Runs started with Mabillon 0.10.0 or 0.11.0
count as `--chrono` runs.

## Files and the store

The rendered files are byte-identical to what the tool's `render` command produces from
the store. They are registered in the store's `outputs` table with their hashes.

With `--formats txt,md`, a transcription also writes `<name>.md`. ChronoMiner then
refuses a run over that folder, since `<name>.txt` and `<name>.md` would share
`<name>_output.json`.

### Hash guard

A file whose contents match neither its registered hash nor the new rendering is kept
unless `--force` is given. An example is a file edited by hand. The document is then
reported with an error, since its files are not current.

### Documents and units in the store

Each store holds one document per input, as the tool defines it:

- ChronoTranscriber: an image folder or a PDF.
- ChronoMiner: a text, a PDF or a single image. An image folder therefore becomes one
  ChronoMiner document per image.

Every unit of the document is stored. Units that no run has worked yet are stored as
`pending`. A unit closed for human review is stored as `failed`, and its draft is kept
only in the Mabillon sidecar. The rows that Mabillon writes name `mabillon` as their
tool.

### Single images and multi-page TIFFs

A transcription of a single image file, a multi-page TIFF, or a folder holding one gets
its files and a sidecar but no store row, with a warning, since ChronoTranscriber's
pages differ from Mabillon's there. Such a run is refused when the files belong to a
document in the store.

An extraction of a multi-page TIFF is refused, since ChronoMiner reads it as one image.
Standalone mode can extract it.

## Adoption, leases and refusals

A run opens an existing store only when its schema versions are the ones Mabillon
writes.

Before it deletes or changes anything, also under `--force`, a run refuses a store
document in either of these cases:

- another run holds an unexpired lease of it, Mabillon runs included,
- its units await a batch.

Without `--force`, a run also refuses:

- a store document of another input,
- a ChronoMiner document with chunks extracted with another schema,
- a document whose units were laid out differently, that is, with other pages or line
  ranges.

Units that another tool has already finished in the store are adopted instead of being
worked again. The sidecar records them under `adopted_from`. Required fields that the
store has no value for, such as `image_analysis`, are left empty. A unit whose row
another tool has reset, failed or marked stale since Mabillon exported it (another
`run_id`, status or the stale flag) is worked again.

A rendered file that cannot be replaced fails the document. `--force` never deletes a
working folder that holds the run of another input or of the other command
(`transcribe` or `extract`).

## Correction mode

`--drafts <path>` starts a fresh run from the units that another run stored, and the
agent corrects them instead of working the units from scratch. It works with and
without `--chrono`, because Mabillon only reads the drafts store. The path is a
`chronotranscriber.sqlite` (for `transcribe`) or a `chronominer.sqlite` (for
`extract`), or an output root that holds one:

```bash
mabillon transcribe book.pdf --drafts ct_out/ --out corrected/
mabillon extract prices.txt --schema PriceListEntries --drafts prices_cm/chronominer.sqlite
```

### Finding the drafts

The store document is found by its recorded input path, compared without case on
Windows and macOS. For an image folder in extraction, each image has its own
ChronoMiner document. The input hash that the store recorded must be that of the
current input. A document without a hash is accepted with a warning, as
ChronoTranscriber does. When several documents have the same input,
`--drafts-document <name>` chooses one of them; inputs with a single document keep it.

A ChronoTranscriber document of native PDF text has no pages and is refused. Converted
inputs (HTML, DOCX, EPUB) cannot take drafts, since their stored input is the
converted text of another run.

Mabillon reads the store through the tools' views (`page_text`, `chunks`). It writes
to the store only when the store is also the run's output store, which needs
`--chrono`.

### Seeding the units

In transcription, each page that is done, not stale and of outcome `ok` seeds its unit
file: the stored text goes below a front matter whose required fields are empty. For an
image folder, this happens only when the stored page names the unit's image. A page
whose stored image name does not match is worked from scratch and not adopted.

In extraction, each done chunk seeds its unit with its stored answer. For a text,
ChronoMiner's chunk ranges become Mabillon's units, counted on ChronoMiner's lines
(trailing blank lines included). A range that the text cannot hold is refused.

Units without a draft, and units whose draft is empty or not a JSON object (with a
warning), are worked from scratch, and their unit message says so. With `--chrono`, the
seeded files are written once the output store has accepted the document. A copy of
each draft is kept in `run/drafts/`.

The system prompt then asks the agent to correct an erroneous transcription or
extraction. The message of a seeded unit names its unit file as holding one that
contains errors, without repeating its content. Without `--drafts`, the prompt is the
one of an ordinary run.

### Recording and resuming

The state and every page or unit record of the sidecar note the draft's store,
document, tool, run and the SHA-256 of the seeded file under `draft`. The experiment
settings record `correction: true`, so a resume needs `--drafts` again.

### Drafts store as output store

Writing the correction into the drafts store itself, where the drafts store is also
the output store, needs `--chrono`. The drafted units are then worked again rather
than adopted. `--force` is refused, since it would reset the drafts. Drop the
documents with the tool, or write to a separate `--out`.

In this case, a done row of the output store is replaced only by a unit that commits.
A correction closed for review leaves the stored row as it was and is reported in the
state and sidecar only. Done units without a draft are adopted as in any `--chrono`
run. A corrected unit whose row another tool replaces later is corrected again from its
draft on the next run, never adopted.

## Interop check

`test/interop/check.py` opens the outputs with the Chrono tools' own code. With
`MABILLON_INTEROP_OUT=<dir>` set, `npm test -- test/interop.test.ts` writes its
scenarios to `<dir>`. The script, run from a ChronoTranscriber or ChronoMiner checkout,
checks the store schema, the byte-identical rendering, the views, and the dry runs of
`transcribe` or `extract`, `drop` and `repair`:

```bash
uv run --directory ../ChronoTranscriber python -X utf8 "$PWD/test/interop/check.py" <dir>
uv run --directory ../ChronoMiner python -X utf8 "$PWD/test/interop/check.py" <dir>
```
