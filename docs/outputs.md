# Outputs

This page describes the files that a run writes in the default (standalone) mode, the
sidecar with its run metadata, and the working files. The additional store handling
of `--chrono` is in [chrono.md](chrono.md).

## Where the files go

Without `--out`, the outputs go beside each input, and the input's folder is the output
root. With `--out`, the output root is that folder, and `--layout` places the files
below it, as the option of that name does in ChronoTranscriber and ChronoMiner.

| Command | Files | `--layout` below `--out` | `--formats` |
| --- | --- | --- | --- |
| `transcribe` | `<name>.txt`, `<name>.md` | `hash` (default): `<name>-<hash>/<name>.txt`; `mirror`: the input's relative folder | `txt` (default), `md` |
| `extract` | `<stem>_output.json`, `<stem>_output.csv` | `flat` (default): directly in `--out`; `mirror`: the input's relative folder | `json` (always), `csv` |

The names, locations, options and defaults are the tools' own, in both modes.

## Standalone mode

By default, Mabillon opens, creates or changes no `chronotranscriber.sqlite` or
`chronominer.sqlite` and takes no leases. Nothing is adopted from a store. A run whose
output root already holds the store of its command (`chronotranscriber.sqlite` for
`transcribe`, `chronominer.sqlite` for `extract`) is refused before any document is
touched: rerun it with `--chrono` to write into that store, or set `--out` to write
elsewhere.

A transcription writes `<name>.txt`, and with `--formats txt,md` also `<name>.md`.
Both are rendered from the finished units in ChronoTranscriber's page format, where a
page closed for review is a line with its image label and `[transcription error]`.

An extraction writes `<stem>_output.json`. It is one object in the shape of the
extraction schema, made from the committed units. Their entries are concatenated in
document order, and other top-level fields take the first non-null value of any of
them. Units closed for review are left out; their drafts are in the sidecar, whose
`merged` object includes them. The file is written once the first unit is committed.

When a top-level field such as a running city heading changes from unit to unit, the
file can hold only its first value. The run then reports a warning that names the
field, and the sidecar gives every entry its own unit's values (see below).

`--formats json,csv` adds `<stem>_output.csv` with one row per entry. Nested objects
are flattened to dotted column names, and lists of scalars are joined with "; ". The
file is UTF-8 with a byte order mark, as ChronoMiner writes its CSV.

An image folder gives one `<folder>_output.json` for the whole folder, beside its
sidecar. A multi-page TIFF can be extracted.

A rendered file whose contents match neither the last export nor the new rendering is
kept unless `--force` is given. An example is a file that was edited by hand. The
document is then reported with an error, since its files are not current.

Two documents whose rendered files or sidecars would share a path are refused before
any agent work.

## Sidecar

Each document also gets a sidecar beside its rendered files: `<name>.mabillon.json`
for a transcription and `<stem>_output.mabillon.json` for an extraction.

- A transcription sidecar has the form `{mabillon: {...}, pages: [...]}`, where
  `mabillon` holds the run metadata. Each page holds the schema fields plus `unit`,
  `status`, `page`, and the source image or PDF page.
- An extraction sidecar has the form `{mabillon, merged, entries, units, work_dir}`.
  `merged` is one object in the shape of the extraction schema, with the entries of
  all units concatenated in document order. Other top-level fields take the first
  non-null value of any unit. `entries` gives the unit (page or line range) of every
  entry. `units` holds per-unit status, entry counts, top-level field values, and
  carry-over notes. If the merged object does not validate against the schema, for
  example because a unit closed for review is invalid, the errors are listed under
  `final_validation`.

Some top-level fields change from unit to unit, such as the running city heading of a
guide (a field like `active_city_or_town`). They cannot be represented in the merged
object. They are listed under `mabillon.varying_fields`, and every entry in `entries`
carries its unit's values in `unit_fields`.

## Run metadata

The `mabillon` object of the sidecar records the run, so that experiment arms are
self-describing:

- `complete` is true when every unit of the document finished. For runs limited with
  `--units`, `selection` lists the IDs and states of the selected units.
- `implementation` holds the package version, and for a checkout also the git commit
  and the uncommitted changes.
- `experiment` holds the tool set, the resolved settings, the context file hashes, the
  boundary policy and the system-prompt hash.
- `session_settings` holds model, thinking level, tools and image profile per session.
  For OpenRouter it also holds the routing preferences and the upstream providers that
  served the session, and the OpenAI service tier where one was requested.
- `image_fallbacks` and `uncovered_lines` record the image downgrades and the source
  lines that no line range covers.
- `units_closed_by_hard_cap` and `units_with_soft_cap_blocks` list the units shaped by
  the tool budget. Per unit, `hard_cap_closed`, `soft_cap_blocks` and the committing
  `session` are recorded.

Each page (transcription) or provenance unit record lists its remaining verification
issues under `issues`. The metadata counts them as `warnings` and `units_with_warnings`.

A finished unit whose committed copy is missing or was changed is not exported. Its
record has `integrity_error`, and the next run reopens and redoes it.

## Working files

Working files live in `<output root>/.mabillon/<name>/`, a folder that the discovery of
Mabillon, ChronoTranscriber and ChronoMiner skips.

- `work/` is the agent's workspace: `units/`, `notes.md`, `scratch/`, and text chunks
  in `source/`.
- `run/` holds Mabillon's own state: `state.json`, the canonical committed units in
  `committed/`, the converted text, and the pi session logs in `sessions/`. Page
  images are removed from the logs unless `--keep-session-images` is set.

How `<name>` is formed is described in [runs.md](runs.md).

## Runs before 0.10.0

Runs of Mabillon before 0.10.0 wrote `<--out>/<stem>/` or, without `--out`,
`chronoagent_output/<stem>/` beside the input, with `<stem>.json`, `<stem>.md` and
`<stem>.provenance.json`. They are neither resumed nor converted. While such a folder
holds a run state, a run of the same document stops with a message naming the folder.
Finish the run with the earlier version, or move the folder away and run the document
again. Read old runs, such as the frozen Mabillon-eval runs, from their own layout.
