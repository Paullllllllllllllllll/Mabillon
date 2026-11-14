---
name: mabillon
description: >-
  Mabillon. Use when the user wants a historical PDF, scan or book transcribed page by
  page, schema-validated records extracted from PDFs, images or text files,
  ChronoTranscriber or ChronoMiner drafts corrected by an agent, or checks, verifies
  or reads a Mabillon run (.mabillon.json, mabillon status).
---

# Mabillon

Mabillon is a command-line agent on the pi harness: it works through a document page
by page or chunk by chunk, zooms into page images and validates every unit against a
JSON schema before it moves on (units adopted from a ChronoTranscriber or ChronoMiner
store excepted). It runs headless and never prompts. The README and
the pages in `docs/` document every behavior (`docs/runs.md` the JSON results,
`docs/outputs.md` the files); `mabillon --help` lists the flags. Call it with `--json
--quiet`, which prints one JSON result on stdout and no progress:

```bash
mabillon transcribe <pdf|image|folder>... --model <provider/id> --out <dir> --json --quiet [options]
mabillon extract <pdf|image|folder|text file>... --schema <name|path> --model <provider/id> --out <dir> --json --quiet [options]
mabillon status [output dir] --json        # progress of running or finished runs, no model call
mabillon verify <file> [--schema <name>] --json   # validate an output file, no model call
mabillon schemas --json                    # list the available schemas
```

Without `npm link`, call `node <clone>/dist/bin.js` with the same arguments. Models
are `provider/id`; a ChatGPT login is provider `openai` (`--model
openai/gpt-6-luna`). A `mabillon.yaml` (or `.yml`) in the working directory sets
options the command line does not show, such as `units`, `force`, `bash` or `zdr`:
read it before a run, or pass `--config` with an empty file. `--no-force`,
`--no-bash` and `--zdr` override it.

## Running a job

1. **Agree the scope.** Runs take minutes per page with strong models and draw on the
   user's model account. Done when the user has approved the documents, the units
   (`--units 1-20`), the model and the thinking level (`--thinking`) of anything
   beyond a trial.
2. **Trial.** Run one document with three units from the approved range that are not
   yet committed (`--units 1-3`), and note its wall-clock time. A single document's
   trial writes to the job's own `--out`, and the full run resumes it. For a folder of
   documents or several inputs, take one document from inside them and give the trial
   a separate `--out`, since the full run maps it to other work and output paths; a
   folder of page images is one document, so trial the folder itself. Read the
   outputs, `units_needs_review` and the cost, which is pi's estimate at API rates
   and sums all sessions of the document, so take the difference on a resumed one.
   Project the full run's time and cost from the units the trial actually selected.
   Done when the user has seen the quality and the projection and approved the full
   run.
3. **Full run.** Start the approved inputs with the approved `--units` (none when
   whole documents were approved) in the background, and check progress with
   `mabillon status <out dir> --json`, which reports a document as running while a
   process holds it. When the projection exceeds your agent's time limit for one
   command, split the units into consecutive `--units` ranges and start each range
   when the previous one has returned; every range resumes into the same `--out`.
   An approved `--force` goes on the first command only, and later ranges pass
   `--no-force`: a forced command discards the work of the earlier ranges. Done when
   the last command has printed its JSON result and its selection covered the
   approved units.
4. **Report** from each result, which covers only the units that command selected.
   A result with `error` and no `documents` failed before any document started:
   report the error. Otherwise report each document's `status`, the units in
   `units_needs_review` with their reasons, `warnings` and `error`, and every input
   under `skipped` with its reason. Also report the warnings committed units carry,
   listed under `issues` per page or unit in the sidecar. Exit code 3 means finished
   with units closed for review, never a clean result. After split ranges, `status
   <out dir>` gives the whole-document totals. For an extraction, also report
   `final_validation` and `varying_fields` from the sidecar's `mabillon` metadata; a
   field listed under `varying_fields` lives per entry in the sidecar's
   `entries[].unit_fields`, not in `merged`. Done when every requested input is
   accounted for in `documents`, `skipped` or the error.

## Reference

- Exit codes: 0 every selected unit committed; 1 incomplete or failed documents (or
  `verify` errors); 2 usage, configuration or credential error; 3 finished with units
  closed for review; 130 interrupted. Every JSON result has `ok` and `exit_code`.
  Rerunning the same command resumes from the last committed unit.
- Outputs go beside each input or under `--out` (`--layout`, `--formats`):
  `<name>.txt` (and `<name>.md` with `--formats txt,md`) for a transcription,
  `<stem>_output.json` (and `.csv` with `--formats json,csv`) for an extraction, and a
  sidecar `<name>.mabillon.json` (extraction: `<stem>_output.mabillon.json`) with run
  metadata and drafts closed for review. Working files go to `<output
  root>/.mabillon/`.
- `--chrono` writes ChronoTranscriber's or ChronoMiner's files and SQLite store
  instead, so those tools can render, repair and resume the documents; pass it when
  the user works with those tools. A run resumes only with the setting it started
  with, and a run without `--chrono` refuses an output root that holds the command's
  store. With `--chrono`, a document another tool's run holds is refused while that
  run's lease lasts; a killed run's lease expires after ten minutes. Units the other
  tool finished in the store are adopted as they stand, without Mabillon's checks;
  correction mode (`--drafts`) has the agent check them. A single image or a
  multi-page TIFF gets no store document, so the tool cannot render or repair it.
- Transcribe first, then extract from the transcript: `mabillon extract <name>.txt
  --schema <name>`, with the path the transcription's result lists.
- Correction mode: `--drafts <chronotranscriber.sqlite | chronominer.sqlite | output
  root>` seeds the units from another tool's run, and the agent corrects them; a
  resume needs `--drafts` again.
- Schemas: the bundled transcription and extraction schemas are copies; `--schemas-dir
  <dir>` adds a folder whose file of the same name shadows the copy, as for a run that
  shares a store with a ChronoTranscriber or ChronoMiner run.
- Context about the source (language, period, script or typeface, layout) goes in a
  `.md` file passed as `--context`, or in `<stem>.context.md` beside the input.
- `--force` discards the documents' work (with `--chrono`, their store units too), and
  `--bash` gives the agent an unsandboxed shell: use either only with the user's
  consent. `--redo-review` reruns the units closed for review.
- OpenRouter models (`openrouter/<vendor>/<model>`) use zero-data-retention endpoints
  only, unless `--no-zdr` or `zdr: false` in the settings file (`--zdr` restores
  it); `--openrouter-providers` pins the upstream providers. Exit code 2 with "no
  endpoint" means no endpoint meets these settings.
- Credentials are pi's (`~/.pi/agent`). When a result reports no model, rejected
  credentials or an expired login (exit code 2), ask the user to run `mabillon tui`
  and `/login`, or to pass `--model`.
- Two commands on one document at once: the second fails with a lock message.
- Permissions: to let Claude Code run it without prompting, allow `Bash(mabillon:*)`
  in the project's `.claude/settings.json` (or `Bash(node <clone>/dist/bin.js:*)`).
