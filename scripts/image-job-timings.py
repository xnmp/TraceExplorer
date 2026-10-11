#!/usr/bin/env python3
"""Show where the time went in recent AI image jobs. Read-only.

Joins Trace's private `image_service_timings` table with the image provider's
private `operations.timings` column on the operation id, orders every recorded
stage by wall-clock time, and prints each stage's offset from `run_created` and
the gap since the previous stage. The largest gap is marked.

    python3 -I scripts/image-job-timings.py [-n 5] [--operation ID]
    python3 -I scripts/image-job-timings.py --self-test

Rows written before timings existed simply have fewer (or no) stages.
"""
import argparse
import contextlib
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

def config_base():
    """The platform's per-user config directory, as Tauri Explorer uses it."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    if sys.platform in ("win32", "cygwin"):
        return Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


DATA = config_base() / "tauri-explorer" / "plugin-data"
DEFAULT_PROVIDER = DATA / "xnmp.image-generation" / "operations.sqlite"
DEFAULT_TRACE = DATA / "xnmp.trace-explorer" / "trace.sqlite"


def open_ro(path, stack):
    """Open a private copy of the database, or None when it is absent or unreadable.

    Opening a WAL database in place, even with mode=ro, can create -wal/-shm
    files beside it. A copy (with its -wal when present) leaves the original
    untouched; the copy is removed when `stack` closes.
    """
    path = Path(path)
    if not path.is_file():
        return None
    try:
        scratch = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="image-job-timings-")))
        copy = scratch / "snapshot.sqlite"
        shutil.copyfile(path, copy)
        wal = path.with_name(path.name + "-wal")
        if wal.is_file():
            shutil.copyfile(wal, scratch / "snapshot.sqlite-wal")
        con = sqlite3.connect(str(copy))
        stack.callback(con.close)
        con.execute("SELECT 1 FROM sqlite_master LIMIT 1")
        return con
    except (sqlite3.Error, OSError) as error:
        print(f"warning: cannot read {path}: {error}", file=sys.stderr)
        return None


def columns(con, table):
    return {row[1] for row in con.execute(f"PRAGMA table_info({table})")}


def query(con, sql, args=()):
    try:
        return con.execute(sql, args).fetchall()
    except sqlite3.Error as error:
        print(f"warning: {error}", file=sys.stderr)
        return []


def as_int(value):
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def trace_jobs(con, operation, limit):
    """[(operation_id, phase)] newest first, from Trace's operation links."""
    if con is None or "image_service_operations" not in tables(con):
        return []
    if operation:
        rows = query(con, "SELECT operation_id,body FROM image_service_operations WHERE operation_id=?", (operation,))
    else:
        rows = query(con, "SELECT operation_id,body FROM image_service_operations ORDER BY run_id DESC LIMIT ?", (limit,))
    jobs = []
    for op, body in rows:
        try:
            phase = json.loads(body).get("phase", "?")
        except (TypeError, ValueError, AttributeError):
            phase = "?"
        jobs.append((op, phase))
    return jobs


def tables(con):
    return {r[0] for r in query(con, "SELECT name FROM sqlite_master WHERE type='table'")}


def trace_stages(con, operation):
    if con is None or "image_service_timings" not in tables(con):
        return {}
    rows = query(con, "SELECT stage,at_ms FROM image_service_timings WHERE operation_id=?", (operation,))
    return {f"trace.{stage}": at for stage, at in rows if as_int(at) is not None}


def provider_rows(con, operation, limit):
    """[(operation_id, admitted_ms, timings dict)] newest first."""
    if con is None or "operations" not in tables(con):
        return []
    has = columns(con, "operations")
    timings = "timings" if "timings" in has else "NULL"
    admitted = "admitted_at_ms" if "admitted_at_ms" in has else "0"
    sql = f"SELECT operation,{admitted},{timings} FROM operations"
    if operation:
        rows = query(con, sql + " WHERE operation=?", (operation,))
    else:
        rows = query(con, sql + f" ORDER BY {admitted} DESC LIMIT ?", (limit,))
    out = []
    for op, at, raw in rows:
        try:
            parsed = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            parsed = {}
        stages = {k: v for k, v in parsed.items() if isinstance(parsed, dict) and as_int(v) is not None}
        out.append((op, at or 0, stages))
    return out


def merge(trace, provider):
    stages = dict(trace)
    stages.update({f"provider.{k}": v for k, v in provider.items()})
    return sorted(stages.items(), key=lambda kv: (kv[1], kv[0]))


def render(op, phase, stages, color=False):
    lines = [f"operation {op}" + (f"  ({phase})" if phase else "")]
    if not stages:
        lines.append("  no timings recorded (job predates timing support)")
        return lines
    origin = dict(stages).get("trace.run_created", stages[0][1])
    gaps = [0] + [stages[i][1] - stages[i - 1][1] for i in range(1, len(stages))]
    biggest = max(range(len(stages)), key=lambda i: gaps[i]) if len(stages) > 1 and max(gaps) > 0 else None
    width = max(len(name) for name, _ in stages)
    lines.append(f"  {'stage':<{width}}  {'offset':>9}  {'gap':>9}")
    for i, (name, at) in enumerate(stages):
        row = f"  {name:<{width}}  {(at - origin) / 1000:>8.1f}s  {gaps[i] / 1000:>8.1f}s"
        if i == biggest:
            row += "  <-- largest gap"
            if color:
                row = f"\033[1m{row}\033[0m"
        lines.append(row)
    lines.append(f"  total {(stages[-1][1] - stages[0][1]) / 1000:.1f}s across {len(stages)} stages")
    return lines


def report(provider_db, trace_db, operation, limit, color=False):
    with contextlib.ExitStack() as stack:
        return _report(stack, provider_db, trace_db, operation, limit, color)


def _report(stack, provider_db, trace_db, operation, limit, color):
    trace, provider = open_ro(trace_db, stack), open_ro(provider_db, stack)
    if trace is None and provider is None:
        return ["no Trace or provider database found", f"  {trace_db}", f"  {provider_db}"]
    jobs = trace_jobs(trace, operation, limit)
    if not jobs:  # Trace unavailable or has no such job: fall back to the provider's own list
        jobs = [(op, "") for op, _, _ in provider_rows(provider, operation, limit)]
    lines = []
    for op, phase in jobs:
        theirs = {}
        for _, _, stages in provider_rows(provider, op, 1):
            theirs = stages
        lines += render(op, phase, merge(trace_stages(trace, op), theirs), color) + [""]
    if not jobs:
        lines.append("no image jobs found")
    return lines


def self_test():
    with tempfile.TemporaryDirectory(prefix="image-job-timings-") as scratch:
        _self_test(Path(scratch))


def _self_test(root):
    t0 = 1_800_000_000_000

    def make_trace(path):
        con = sqlite3.connect(path)
        con.executescript(
            "CREATE TABLE image_service_operations(operation_id TEXT PRIMARY KEY,run_id INTEGER,job_id INTEGER,request_digest TEXT,body TEXT);"
            "CREATE TABLE image_service_timings(operation_id TEXT,stage TEXT,at_ms INTEGER,PRIMARY KEY(operation_id,stage));"
        )
        con.execute("INSERT INTO image_service_operations VALUES('old',1,1,'d','{\"phase\":\"succeeded\"}')")
        con.execute("INSERT INTO image_service_operations VALUES('new',2,2,'d','{\"phase\":\"succeeded\"}')")
        stages = {"run_created": 0, "submitted": 100, "accepted": 300, "success_observed": 62_000,
                  "transfer_started": 62_500, "output_written": 63_000, "transfer_done": 63_100, "run_finished": 63_300}
        con.executemany("INSERT INTO image_service_timings VALUES('new',?,?)", [(k, t0 + v) for k, v in stages.items()])
        con.commit()
        con.close()

    def make_provider(path, with_column=True):
        con = sqlite3.connect(path)
        con.execute("CREATE TABLE operations(caller TEXT,operation TEXT,admitted_at_ms INTEGER" + (",timings TEXT" if with_column else "") + ")")
        if with_column:
            stages = {"admitted": 150, "credential_check_started": 160, "credential_check_done": 1_900, "process_started": 1_950,
                      "process_finished": 61_800, "output_found": 61_850, "output_stored": 61_900, "delivery_acquired": 63_200}
            con.execute("INSERT INTO operations VALUES('c','new',?,?)", (t0 + 150, json.dumps({k: t0 + v for k, v in stages.items()})))
            con.execute("INSERT INTO operations VALUES('c','old',?,NULL)", (t0 - 10_000,))
        else:
            con.execute("INSERT INTO operations VALUES('c','old',?)", (t0 - 10_000,))
        con.commit()
        con.close()

    def run(provider, trace, **kw):
        return "\n".join(report(provider, trace, kw.get("operation"), kw.get("limit", 5)))

    weird = root / "we?ird#%dir"
    weird.mkdir()
    make_trace(weird / "trace.sqlite")
    make_provider(root / "operations.sqlite")
    out = run(root / "operations.sqlite", weird / "trace.sqlite")
    assert "provider.process_finished" in out and "trace.run_finished" in out, out
    # Stages interleave by time across both databases.
    assert out.index("trace.submitted") < out.index("provider.admitted") < out.index("trace.accepted"), out
    assert out.index("provider.process_started") < out.index("provider.process_finished") < out.index("trace.success_observed"), out
    # The 59.9s provider process is the largest gap, and only it is marked.
    marked = [line for line in out.splitlines() if "largest gap" in line]
    assert len(marked) == 1 and "provider.process_finished" in marked[0] and "59.9s" in marked[0], out
    assert "offset" in out and "total 63.3s" in out, out
    # A job from before timings existed shows a notice, not a crash.
    assert "operation old" in out and "no timings recorded" in out, out
    # One operation, selected by id.
    single = run(root / "operations.sqlite", weird / "trace.sqlite", operation="new")
    assert "operation old" not in single and "provider.output_found" in single, single
    assert run(root / "operations.sqlite", weird / "trace.sqlite", operation="missing").endswith("no image jobs found")
    # A provider journal from before the column existed.
    make_provider(root / "legacy.sqlite", with_column=False)
    legacy = run(root / "legacy.sqlite", weird / "trace.sqlite")
    assert "trace.run_finished" in legacy and "provider." not in legacy, legacy
    # Missing databases.
    assert "no Trace or provider database" in run(root / "none-a", root / "none-b")
    only_provider = run(root / "operations.sqlite", root / "none-b")
    assert "provider.delivery_acquired" in only_provider, only_provider
    # Read-only: the files are unchanged by reporting.
    before = (root / "operations.sqlite").read_bytes()
    run(root / "operations.sqlite", weird / "trace.sqlite")
    assert (root / "operations.sqlite").read_bytes() == before
    # A live WAL database: its newest rows sit in the -wal, and reporting
    # neither misses them nor creates, changes or removes any file beside it.
    live = root / "live"
    live.mkdir()
    wal = sqlite3.connect(live / "operations.sqlite")
    wal.execute("PRAGMA journal_mode=WAL")
    wal.execute("PRAGMA wal_autocheckpoint=0")
    wal.execute("CREATE TABLE operations(caller TEXT,operation TEXT,admitted_at_ms INTEGER,timings TEXT)")
    wal.execute("INSERT INTO operations VALUES('c','new',?,?)", (t0, json.dumps({"admitted": t0, "output_found": t0 + 5_000})))
    wal.commit()
    assert (live / "operations.sqlite-wal").exists()
    snapshot = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in live.iterdir()}
    live_out = run(live / "operations.sqlite", weird / "trace.sqlite", operation="new")
    assert "provider.output_found" in live_out, live_out
    assert {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in live.iterdir()} == snapshot
    wal.close()
    # Default paths follow the platform.
    assert str(DEFAULT_PROVIDER).endswith(os.path.join("tauri-explorer", "plugin-data", "xnmp.image-generation", "operations.sqlite"))
    print(out)
    print("self-test ok")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("-n", "--limit", type=int, default=5, help="number of recent jobs (default 5)")
    parser.add_argument("--operation", help="show one operation id")
    parser.add_argument("--provider-db", default=str(DEFAULT_PROVIDER), help="image provider operations.sqlite")
    parser.add_argument("--trace-db", default=str(DEFAULT_TRACE), help="Trace trace.sqlite")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    print("\n".join(report(args.provider_db, args.trace_db, args.operation, max(args.limit, 1), sys.stdout.isatty())))


if __name__ == "__main__":
    main()
