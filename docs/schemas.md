# Schemas

This page documents the schemas that ship with Mabillon, how to select or add one,
the rules files that go with a schema, and what an extraction schema must contain.
Mabillon reads the JSON schema format of ChronoTranscriber and ChronoMiner: the
`{name, strict, schema}` wrapper and the
`{contains_no_content_of_requested_type, entries}` envelope.

## Bundled schemas

Bundled schemas live in `schemas/`:

- `transcription/diplomatic_markdown_transcription.json` is the default. It asks for
  diplomatic transcription with markdown structure, `<page_number>`, footnotes,
  `![Image: ...]`, and the uncertainty markers `<unclear>...</unclear>` and `<gap/>`.
- `transcription/markdown_transcription_schema.json`,
  `plain_text_transcription_schema.json` and
  `plain_text_transcription_with_markers_schema.json` are copies of
  ChronoTranscriber's transcription schemas as of 02.10.2026 (commit `d4a4afd`).
- `extraction/` holds copies of ChronoMiner's example extraction schemas.

`mabillon schemas` lists them together with any schema file that could not be loaded
and the reason (`load_errors` with `--json`).

## Selecting a schema

`--schema` accepts a schema name, a file stem, or a path. `--schemas-dir` adds
directories, and their schemas shadow bundled schemas of the same name. A schema can
be either a wrapper `{name, strict, schema}` or a bare JSON Schema. A user schema that
fails to load is reported as an error instead of falling back to a bundled schema of
the same name.

## Rules files

An optional rules file sits in a `rules/` folder next to the schema, or in
`schemas/rules/` of this package, and is named `<schema name>.rules.json`:

```json
{
  "verbatimFields": ["text_original", "title_original"],
  "bodyField": "transcription"
}
```

- `verbatimFields` lists the entry fields that are checked against the source text
  (see [verification.md](verification.md)).
- `bodyField` names the field of a transcription schema that receives the Markdown
  body of a unit file.
- `boundary` sets how extraction treats entries that cross a unit boundary.
  `"complete"` (default) records the whole entry in the unit where it begins, reading
  ahead and passing a carry-over note. `"fragments"` records each unit's part as its
  own entry, flagged as a fragment. Without the key, a schema whose entries have a
  boolean field with "fragment" in its name, such as `entry_is_fragment`, uses
  `"fragments"`.

## Extraction schemas

An extraction schema must have a top-level `entries` array, optionally with
`contains_no_content_of_requested_type` and other top-level fields. The outputs
concatenate the entries of all units, so other extraction schemas are refused at the
start of a run.

## Uncertain readings

For doubtful readings, the transcription prompt follows the schema's own instruction
when the description of its body field has one, for example a rule for uncertain or
illegible text. Otherwise the agent uses `<unclear>...</unclear>` and `<gap/>`.
