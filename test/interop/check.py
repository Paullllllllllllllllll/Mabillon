"""Open the stores Mabillon wrote with ChronoTranscriber's or ChronoMiner's own code.

Run it from the tool's repository on the scenario folders that test/interop.test.ts
writes when MABILLON_INTEROP_OUT is set (one folder per scenario, with a
scenario.json); no model is called:

    uv run --directory <ChronoTranscriber> python -X utf8 test/interop/check.py DIR
    uv run --directory <ChronoMiner> python -X utf8 test/interop/check.py DIR

For each scenario of the installed tool it checks that the store has the tool's
exact schema, that the tool's renderers reproduce every registered file byte for
byte and its render command rewrites none, that the read views answer, that a
dry run of transcribe or extract classifies each document as the scenario
expects, and that drop and repair accept the store in dry runs. For
ChronoTranscriber it also adds a document of its own to a copy of a Mabillon
store and renders the mixed store. The exit code is 0 when every check passes.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

TOOL = (
    "chronotranscriber"
    if importlib.util.find_spec("chronotranscriber")
    else "chronominer"
)

if TOOL == "chronotranscriber":
    from chronotranscriber.output.render import (
        RENDERERS,
        preview_database,
        render_database,
        render_item,
    )
    from chronotranscriber.output.store import (
        DATABASE_NAME,
        open_store,
        read_only_connection,
    )
    from chronotranscriber.sources import discover_items as ct_discover
else:
    from chronominer.discovery import discover_items as cm_discover
    from chronominer.output.render import RENDERERS, preview_database, render_database
    from chronominer.output.store import (
        DATABASE_NAME,
        open_store,
        read_only_connection,
    )

FAILURES: list[str] = []
CHECKS = 0


def check(condition: bool, message: str) -> None:
    """Record one check; a failed one is reported at the end."""
    global CHECKS
    CHECKS += 1
    if not condition:
        FAILURES.append(message)
        print(f"  FAIL {message}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def schema_dump(path: Path) -> tuple[list[Any], list[Any]]:
    connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    try:
        master = connection.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' "
            "AND NOT (type = 'view' AND name = 'entries') "
            "AND NOT (type = 'table' AND name = 'entry_rows') ORDER BY type, name"
        ).fetchall()
        meta = connection.execute(
            "SELECT component, version FROM meta WHERE component != 'dropped_doc_id' "
            "ORDER BY rowid"
        ).fetchall()
    finally:
        connection.close()
    return master, meta


async def _fresh(root: Path) -> None:
    async with open_store(root):
        pass


def check_schema(database: Path) -> None:
    """The store's tables, views, triggers and meta rows equal a fresh store's.

    ChronoMiner's ``entry_rows`` and ``entries`` gain ``f_<field>`` columns with
    the first entries; they are compared through the CM code that reads them.
    """
    with tempfile.TemporaryDirectory() as folder:
        asyncio.run(_fresh(Path(folder)))
        fresh = schema_dump(Path(folder) / DATABASE_NAME)
    check(schema_dump(database) == fresh, f"{database}: schema differs from {TOOL}'s")


def documents(database: Path) -> list[dict[str, Any]]:
    connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in connection.execute("SELECT * FROM documents")]
    finally:
        connection.close()


def outputs_of(root: Path, doc_id: int) -> list[dict[str, Any]]:
    with read_only_connection(root) as connection:
        connection.row_factory = sqlite3.Row
        return [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM outputs WHERE doc_id = ? ORDER BY path", (doc_id,)
            )
        ]


def check_files(root: Path) -> dict[Path, int]:
    """Every registered file matches its hash and the tool's rendering of the store."""
    mtimes: dict[Path, int] = {}
    for document in documents(root / DATABASE_NAME):
        outputs = outputs_of(root, document["doc_id"])
        check(bool(outputs), f"{document['name']}: no registered output")
        for output in outputs:
            path = root / output["path"]
            check(path.is_file(), f"{path}: registered but missing")
            if not path.is_file():
                continue
            data = path.read_bytes()
            mtimes[path] = path.stat().st_mtime_ns
            check(output["stale"] == 0, f"{path}: registered as stale")
            check(
                output["sha256"] == sha256(path), f"{path}: hash differs from outputs"
            )
            with read_only_connection(root) as connection:
                rendered = RENDERERS[output["format"]](connection, document["doc_id"])
            rendered = rendered if isinstance(rendered, bytes) else rendered.encode()
            check(rendered == data, f"{path}: {TOOL} renders other bytes")
    return mtimes


def check_render(root: Path, mtimes: dict[Path, int]) -> None:
    """The tool's render command finds every file current and writes none."""
    database = root / DATABASE_NAME
    for result in preview_database(database):
        check(
            not result.written and not result.kept and not result.stale,
            f"{result.name}: render preview would write {result.written} "
            f"keep {result.kept} stale {result.stale}",
        )
    for result in asyncio.run(render_database(database)):
        check(
            not result.written and not result.kept and not result.stale,
            f"{result.name}: render wrote {result.written} kept {result.kept}",
        )
        check(
            result.skipped is None, f"{result.name}: render skipped ({result.skipped})"
        )
    for path, mtime in mtimes.items():
        check(path.stat().st_mtime_ns == mtime, f"{path}: rewritten by render")


def check_views(root: Path) -> None:
    """The read views answer and agree with the documents' unit counts."""
    with read_only_connection(root) as connection:
        totals = {
            name: total
            for name, total in connection.execute(
                "SELECT name, units_total FROM documents"
            )
        }
        if TOOL == "chronotranscriber":
            rows = connection.execute(
                "SELECT document, count(*) FROM page_text GROUP BY document"
            ).fetchall()
            check(dict(rows) == totals, f"{root}: page_text counts {rows} != {totals}")
            status = connection.execute(
                "SELECT document, units_total FROM document_status"
            ).fetchall()
            check(dict(status) == totals, f"{root}: document_status differs")
            connection.execute("SELECT * FROM page_attempts").fetchall()
        else:
            rows = connection.execute(
                "SELECT document, count(*) FROM chunks GROUP BY document"
            ).fetchall()
            check(dict(rows) == totals, f"{root}: chunks counts {rows} != {totals}")
            for (document,) in connection.execute("SELECT name FROM documents"):
                stored = connection.execute(
                    "SELECT count(*) FROM entries WHERE document = ?", (document,)
                ).fetchone()[0]
                records = json.loads(
                    (root / f"{document}_output.json").read_text(encoding="utf-8")
                )["records"]
                answered = sum(
                    len(
                        json.loads(record["response"]["output_text"]).get("entries", [])
                    )
                    for record in records
                )
                check(
                    stored == answered,
                    f"{document}: entries view {stored} != {answered}",
                )
            connection.execute("SELECT * FROM ranges").fetchall()
        connection.execute("SELECT * FROM classifications").fetchall()


def run_tool(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-X", "utf8", "-m", TOOL, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def json_line(text: str) -> dict[str, Any]:
    for line in reversed(text.splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    raise ValueError(f"no JSON summary in {text[-500:]!r}")


def check_plans(scenario: dict[str, Any]) -> None:
    """Dry runs of the tool classify each document as the scenario expects.

    A scenario lists ``plans`` (extra arguments and expected states) or one
    ``expect`` for a dry run without extra arguments; ``plan: false`` skips it.
    """
    if scenario.get("plan") is False:
        return
    plans = scenario.get("plans") or [{"args": [], "expect": scenario["expect"]}]
    for plan in plans:
        check_plan(scenario, plan["args"], plan["expect"])


def check_plan(
    scenario: dict[str, Any], extra: list[str], expected: dict[str, str]
) -> None:
    source = Path(scenario["input"])
    command = "transcribe" if TOOL == "chronotranscriber" else "extract"
    args = [command, "--input", str(source), "--dry-run", "--json", *extra]
    if scenario.get("output"):
        args += ["--output", scenario["output"]]
    if TOOL == "chronotranscriber":
        args += ["--formats", ",".join(scenario["formats"])]
        if source.is_dir():
            args += ["--type", "images"]
    else:
        args += ["--schema", scenario["schema"]]
        if "csv" in scenario["formats"]:
            args += ["--formats", "csv"]
        if source.is_dir():
            args += ["--all"]
    result = run_tool(*args)
    check(
        result.returncode == 0,
        f"{command} --dry-run exit {result.returncode}: {result.stderr[-400:]}",
    )
    if result.returncode != 0:
        return
    summary = json_line(result.stdout)
    states = {item["name"]: item["state"] for item in summary["to_process"]}
    states.update({name: "complete" for name in summary["skipped"]})
    for bucket in ("unstored", "blocked", "refused"):
        for item in summary.get(bucket, []):
            states[item if isinstance(item, str) else item.get("name")] = bucket
    names = {
        Path(document["input_path"]).name: document["name"]
        for document in documents(root_of(scenario) / DATABASE_NAME)
    }
    for item, name in names.items():
        if name in expected:
            check(
                states.get(item) == expected[name],
                f"{command} {' '.join(extra)} plan of {item}: {states.get(item)}, "
                f"expected {expected[name]}",
            )


def check_drop(root: Path, scenario: dict[str, Any]) -> None:
    result = run_tool("drop", "--input", str(root), "--all", "--dry-run", "--json")
    check(result.returncode == 0, f"drop --dry-run exit {result.returncode}")
    if result.returncode != 0:
        return
    summary = json_line(result.stdout)
    check(summary["refused"] == [], f"drop refused {summary['refused']}")
    for name in scenario["expect"]:
        check(name in summary["dropped"], f"drop would not drop {name}")
    check(not summary["kept_files"], f"drop would keep {summary['kept_files']}")


def check_repair(root: Path, scenario: dict[str, Any]) -> None:
    result = run_tool(
        "repair", "--input", str(root / DATABASE_NAME), "--dry-run", "--json"
    )
    check(
        result.returncode == 0,
        f"repair --dry-run exit {result.returncode}: {result.stderr[-400:]}",
    )
    wanted = sum(len(indices) for indices in scenario.get("repair", {}).values())
    log = result.stdout + result.stderr
    if wanted:
        match = re.search(r"(\d+) (?:page|chunk)\(s\) would be repaired", log)
        found = int(match.group(1)) if match else 0
        check(found == wanted, f"repair --dry-run selects {found}, expected {wanted}")


def check_discovery(root: Path) -> None:
    """Recursive discovery over an output root never enters .mabillon."""
    if TOOL == "chronotranscriber":
        found = [
            *ct_discover(root, "pdf", recursive=True),
            *ct_discover(root, "images", recursive=True),
        ]
    else:
        found = cm_discover(root, recursive=True)
    inside = [item.path for item in found if ".mabillon" in item.path.parts]
    check(not inside, f"discovery entered .mabillon: {inside}")


def root_of(scenario: dict[str, Any]) -> Path:
    if scenario.get("output"):
        return Path(scenario["output"])
    return Path(scenario["input"]).parent


async def _add_ct_document(root: Path, source: Path) -> None:
    from chronotranscriber.common.store import PlannedUnit, UnitResult

    async with open_store(root) as store:
        await store.begin_run("transcribe")
        doc_id = await store.ensure_document(
            "ct/extra", input_path=source, input_sha256="0" * 64, kind="pdf"
        )
        lease = await store.acquire(doc_id)
        assert lease is not None
        label = "page_0001_pre_processed.jpg"
        await store.plan_units(
            lease,
            "page",
            [PlannedUnit(0, label, 0)],
            model="gpt-6-luna",
            provider="openai",
        )
        await store.write_unit(
            lease,
            UnitResult(
                kind="page",
                idx=0,
                status="done",
                model="gpt-6-luna",
                provider="openai",
                content="Written by ChronoTranscriber.",
                outcome="ok",
                label=label,
                source_index=0,
            ),
        )
        await render_item(store, doc_id, ["txt"], root / "ct" / "extra.txt", lease)
        await store.release(lease)
        await store.end_run(0)


def check_mixed(scenario: dict[str, Any]) -> None:
    """A CT document beside Mabillon's in one store: CT renders both, rewrites none."""
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder) / "root"
        shutil.copytree(root_of(scenario), root)
        asyncio.run(_add_ct_document(root, Path(scenario["input"])))
        tools = sorted(document["tool"] for document in documents(root / DATABASE_NAME))
        check(tools == ["chronotranscriber", "mabillon"], f"mixed store holds {tools}")
        mtimes = check_files(root)
        check_render(root, mtimes)
        check_views(root)


def main() -> int:
    base = Path(sys.argv[1])
    scenarios = sorted(base.glob("*/scenario.json"))
    print(f"{TOOL}: {len(scenarios)} scenario folder(s) in {base}")
    for path in scenarios:
        scenario = json.loads(path.read_text(encoding="utf-8"))
        if TOOL == "chronominer":
            # CM discovery runs over every output root, ChronoTranscriber's included.
            check_discovery(root_of(scenario))
        if scenario["tool"] != TOOL:
            continue
        print(f"- {path.parent.name}")
        root = root_of(scenario)
        database = root / DATABASE_NAME
        check(database.is_file(), f"{database} missing")
        if not database.is_file():
            continue
        check_schema(database)
        mtimes = check_files(root)
        check_render(root, mtimes)
        check_views(root)
        check_plans(scenario)
        check_drop(root, scenario)
        check_repair(root, scenario)
        if TOOL == "chronotranscriber":
            check_discovery(root)
            if scenario.get("output"):
                check_mixed(scenario)
    print(f"{CHECKS} checks, {len(FAILURES)} failed")
    return 1 if FAILURES or CHECKS == 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
