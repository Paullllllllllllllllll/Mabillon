# Verification

This page lists what `verify` checks, in order, and how to run the same checks
without a model with `mabillon verify`. The agent calls `verify` on its unit file;
with `final=true` a passing call commits the unit (see [runs.md](runs.md)).

## Checks

`verify` runs these checks in this order:

1. Parsing. Transcription units are parsed as YAML front matter and body, extraction
   units as JSON. Syntax errors are reported with line and column.
2. The full JSON Schema (Draft 2020-12) of the selected schema, not just the subset
   that providers enforce in strict mode.
3. Consistency rules. These relate the transcription flags to the body and the
   `contains_no_content_of_requested_type` flag to `entries`. They also check marker
   syntax: `<page_number>`, `<unclear>`, `<gap/>` and footnotes. Other tags pass only
   if the description of the schema's body field names them.
4. Quality. Schema text or tool markup that leaks into values, generation loops and
   repeated lines are reported.
5. Grounding, for text sources only. Fields that the schema's rules file lists as
   verbatim should occur in the source text. Coverage is measured in word trigrams
   and tolerates ſ, ligatures and line-end hyphenation. A field whose share of
   trigrams found in the source is below `--grounding-threshold` (default 0.8) gets a
   warning, not an error.

   When the verbatim fields of all entries together cover less than half of the words
   of the unit's own chunk (chunks of 300 characters or more), a warning points to
   possibly missing entries. The first `verify final=true` with this warning is
   refused, and a second call commits the unit with the warning kept.
6. Process. The unit's page or text must be in the current context when committing.
   An extraction unit without entries is committed only after a second
   `verify final=true` in a later turn, and with a warning. This applies when a draft
   of the same session had entries or when the unit is a page or a chunk of 300
   characters or more.

Errors block the commit. Warnings are recorded with the unit and in the outputs.

## mabillon verify

`mabillon verify` runs the same checks without a model:

```bash
mabillon verify book.mabillon.json
mabillon verify entries.json --schema BibliographicCatalogueEntries --source catalogue.docx
```

It also reads the schema recorded next to Mabillon outputs and applies the unit checks
to every page of an exported transcription `<stem>.mabillon.json`. The recorded schema
takes precedence over a `schema:` in `mabillon.yaml`; only `--schema` on the command
line overrides it. A file that is not valid UTF-8 fails with an error.
