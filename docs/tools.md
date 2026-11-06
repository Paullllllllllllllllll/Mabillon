# Agent tools

This page lists the tools the agent works with, explains how to change the tool set
with `--tools`, and describes the sandbox for `python` and the shell for `bash`. The
agent has pi's `read`, `write`, `edit` and (opt-in) `bash`, plus Mabillon's own tools.

## Tools

### read, write, edit

These are pi's built-in file tools. They are confined to the agent's work folder.

### bash

pi's shell tool, available only with `--bash`. See [bash](#bash-shell) below.

### view

Available in image modes. `view` shows the current, previous or next page, whole or as
a zoomed region. `box` gives one region in page fractions, and `boxes` gives up to four
regions in one call, one image each. Regions are magnified up to 8x. Optional
enhancements are contrast, threshold and sharpen, applied in the order given, plus
rotation and a labelled coordinate grid.

A `boxes` call that would not fit into one request next to the context images and the
unit's page is refused with the number of regions that fit, so that no region is
dropped unseen.

### add_entries

Available in extraction with an `entries` array. `add_entries` changes the current unit
file without resending or reading it, and creates it with the schema's envelope if
needed. `remove` deletes entries by number. `entries` adds new ones, at the end or at
`position`, so that a correction can take the place of the removed entry. `fields`
sets the other top-level fields, and `resolves` settles rejections. The file is
written as indented UTF-8 JSON.

Each new entry is validated against the schema's entry structure. An invalid entry is
not added. It gets a rejection ID (R1, R2, ...) and the position it belongs at, and it
stays pending, also across sessions, until a later call names it in `resolves`. That
call passes the corrected entry, or the ID alone to drop the entry. Pending rejections
produce a `verify` warning, and the first `final=true` is refused while any remain.

Every result ends with a numbered index of the file's entries, including the slots of
pending rejections. For text units it also reports the share of the chunk that the
verbatim fields cover.

### update_entry

Available in extraction with an `entries` array. `update_entry` changes fields of one
entry, addressed by its number. Each change sets a JSON pointer within the entry to a
value, for example `/title_original` or `/ingredients/2/quantity_original`; `-`
appends to an array. The changed entry must still match the schema's entry structure,
otherwise nothing changes. For text units, the result reports the grounding of the
changed entry and the chunk coverage.

### verify

`verify` validates the current unit file. With `final=true` it commits the unit. The
checks are listed in [verification.md](verification.md).

### python

Available in image units, opt-in with `--python`. `python` runs a Python script that
the agent writes, with the work folder as current folder.

The current, previous and next page are written as lossless PNGs at full resolution to
`source/<id>.png`. Their paths are in `source/pages.json` and in the variables
`MABILLON_PAGE`, `MABILLON_PREVIOUS_PAGE` and `MABILLON_NEXT_PAGE`.

`scratch/pagetools.py` is copied from `python/pagetools.py` at the first session. Its
helpers cover crops, magnification, background removal, binarization (Otsu, Sauvola),
deskewing, line and column detection from projection profiles, captioned line strips,
and side-by-side comparisons of letter forms. The agent may change and extend it, and
its version stays for later units.

Images that the script saves to `scratch/show/` are returned, at most four per call.
The folder is emptied before each call. The images are prepared like `view` images but
never enlarged. Stdout and stderr are returned as well, the last 6,000 characters of
each. A call stops after `python_timeout` seconds (default 120). The interpreter is
`python_path` (default `python`) and needs numpy and Pillow; OpenCV is used when
installed. No environment variable of yours reaches the script.

## Tool sets

`--tools read,write,verify` (or `tools:` in `mabillon.yaml`) sets the exact tool set,
for example for ablations. The default is `read`, `write`, `edit`, `view`, `verify`,
`add_entries` and `update_entry`. Tools that do not apply are left out: `view`
outside image units, `add_entries` and `update_entry` outside extraction.

A tool set must meet these conditions, otherwise it is refused with exit code 2:

- `verify` cannot be left out, nor can `view` (image units) and `read` (text units).
- The set needs a tool that creates the unit file: `write`, or in extraction
  `add_entries`. `bash` and `python` do not count, since they are only add-ons that
  the soft cap takes away.
- Unknown tool names are refused.

`--bash` adds `bash`, and `--no-bash` removes it. Hints of pi's own tools that point
to a disabled tool, such as read's "Use bash: sed ..." for an overlong line, are
rewritten. The prompt, the tool hints and the refusal messages mention only the tools
the agent has. The effective set is recorded per session in the state, as `tools` in
the run metadata of the outputs, and per document in the `--json` result.

## Python sandbox

`python` scripts run in an OS sandbox by default
([sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) 0.0.79,
adapted from pi's example sandbox extension). The sandbox allows no network and
writes only under `scratch/`. It reads only the work folder and the interpreter's own
folders; on macOS and Linux, everything outside the home folder stays readable.

Before the first document, a probe checks inside the sandbox that the interpreter
imports numpy and Pillow, that it can write to `scratch/` and nowhere else, and that a
network connection fails. If the sandbox is missing or leaks, the run stops with exit
code 2.

`--no-python-sandbox` (`python_sandbox: false`) runs the scripts unsandboxed with your
user's permissions. Mabillon itself never follows a link or junction that the script
puts into `scratch/` when it writes the script or when it clears or reads
`scratch/show/`.

### Windows setup

On Windows, the sandbox needs a one-time setup with administrator rights:

```powershell
npx @anthropic-ai/sandbox-runtime@0.0.79 windows-install
```

The setup creates a local account `srt-sandbox`, under which the scripts run, and a
Windows Filtering Platform rule that blocks the outbound connections of that account.
`windows-uninstall` removes both. While a run uses them, Mabillon adds permissions for
that account on the work folder and the interpreter.

The sandbox has three limits on Windows:

- DNS lookups still go through the system resolver.
- Folders that every local user may read stay readable.
- Two Mabillon processes that run python at the same time share the account, and thus
  each other's grants.

## bash (shell)

`bash` is not sandboxed. It runs with your user's permissions. Mabillon keeps its
canonical copies of units outside the agent's reach and restores committed units that
were changed afterwards, but `bash` is off by default. Enable it only for trusted
inputs.

`bash` uses pi's shell. On Windows, pi looks for Git Bash under `Program Files` and
for `bash.exe` on `PATH`. Mabillon also tries a per-user Git install
(`%LOCALAPPDATA%\Programs\Git`). Another shell can be set with `shellPath` in pi's
`settings.json` (`~/.pi/agent`). When `bash` is requested but no shell is found, the
run stops before touching any document (exit code 2).

Every bash command runs with `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`, and on
Windows also with `LC_ALL=C.UTF-8`. A unit file that is not valid UTF-8 fails
`verify` with an error.
