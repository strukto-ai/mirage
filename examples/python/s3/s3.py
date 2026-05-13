# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import copy as _copy
import json
import os
import tempfile
import uuid

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Config, S3Resource
from mirage.workspace.snapshot import ContentDriftError

load_dotenv(".env.development")

config = S3Config(
    bucket=os.environ["AWS_S3_BUCKET"],
    region=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
    aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
    aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
)

backend = S3Resource(config)
ws = Workspace({"/s3/": backend}, mode=MountMode.READ)


def ops_summary() -> str:
    ops = ws.ops
    net = ops.network_bytes
    cache = ops.cache_bytes
    return (f"{len(ops.records)} ops, "
            f"{net} net, {cache} cache")


async def main():
    # ── root listing (tests stat on directory prefixes) ──
    print("=== ROOT LISTING ===\n")

    print("--- ls /s3/ ---")
    r = await ws.execute("ls /s3/")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- tree -L 1 /s3/ ---")
    r = await ws.execute("tree -L 1 /s3/")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- stat /s3/data ---")
    r = await ws.execute("stat /s3/data")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── plan: estimate before executing ──
    print("\n=== PLAN ESTIMATES ===\n")

    dr = await ws.execute("grep mirage /s3/data/example.jsonl", provision=True)
    print("--- plan: grep mirage /s3/data/example.jsonl ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  read_ops: {dr.read_ops}, precision: {dr.precision}")

    dr = await ws.execute("grep mirage /s3/data/example.jsonl | head -n 3",
                          provision=True)
    print("\n--- plan: grep mirage ... | head -n 3 ---")
    print(f"  op: {dr.op}, children: {len(dr.children)}")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  precision: {dr.precision}")
    for c in dr.children:
        net, cache = c.network_read, c.cache_read
        print(f"    {c.command}: net={net}, cache={cache}, {c.precision}")

    dr = await ws.execute("grep mirage /s3/data/example.jsonl && echo found",
                          provision=True)
    print("\n--- plan: grep ... && echo found ---")
    print(f"  op: {dr.op}, network_read: {dr.network_read}")
    for c in dr.children:
        print(f"    {c.command}: net={c.network_read}, {c.precision}")

    print(f"\n  Stats after plans (should be 0): {ops_summary()}")

    # ── cache-aware plan ──
    # Read file to populate cache (cat declares cache, wc materializes)
    print("\n--- caching: cat /s3/data/example.jsonl | wc -l ---")
    result = await ws.execute("cat /s3/data/example.jsonl | wc -l")
    print(f"  lines: {(await result.stdout_str()).strip()}")
    print(f"  Stats after caching: {ops_summary()}")

    dr = await ws.execute("grep mirage /s3/data/example.jsonl", provision=True)
    print("\n--- plan after cache: grep mirage ... ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  cache_hits: {dr.cache_hits}, read_ops: {dr.read_ops}")

    print("\n=== ACTUAL EXECUTION ===\n")

    # ── simple grep ──
    print("--- grep mirage /s3/data/example.jsonl ---")
    output = await (
        await ws.execute("grep mirage /s3/data/example.jsonl")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    if lines:
        print(f"  First: {lines[0][:80]}...")
    print(f"  Stats: {ops_summary()}")

    # ── grep with limit ──
    print("\n--- grep -m 1 mirage /s3/data/example.jsonl ---")
    output = await (
        await
        ws.execute("grep -m 1 mirage /s3/data/example.jsonl")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: grep | wc -l ──
    print("\n--- grep mirage /s3/data/example.jsonl | wc -l ---")
    result = await ws.execute("grep mirage /s3/data/example.jsonl | wc -l")
    print(f"  Count: {(await result.stdout_str()).strip()}")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: grep | head ──
    print("\n--- grep mirage /s3/data/example.jsonl | head -n 3 ---")
    result = await ws.execute("grep mirage /s3/data/example.jsonl | head -n 3")
    lines = (await result.stdout_str()).strip().splitlines()
    print(f"  Lines: {len(lines)}")
    for ln in lines:
        print(f"    {ln[:80]}...")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: cat | grep | sort | uniq ──
    print("\n--- cat /s3/data/example.jsonl"
          " | grep queue-operation | sort | uniq ---")
    result = await ws.execute(
        "cat /s3/data/example.jsonl | grep queue-operation | sort | uniq")
    lines = ((await result.stdout_str()).strip().splitlines() if
             (await result.stdout_str()).strip() else [])
    print(f"  Unique lines: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: grep | cut (extract field) ──
    print("\n--- rg queue-operation /s3/data/example.jsonl"
          " | head -n 5 | cut -d , -f 2 ---")
    result = await ws.execute(
        "rg queue-operation /s3/data/example.jsonl | head -n 5 | cut -d , -f 2"
    )
    print(f"  Fields:\n    {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── && chain: grep && echo ──
    print("\n--- grep -m 1 mirage /s3/data/example.jsonl"
          " && echo 'found mirage' ---")
    result = await ws.execute(
        "grep -m 1 mirage /s3/data/example.jsonl && echo found")
    print(f"  Exit code: {result.exit_code}")
    print(
        f"  Stdout ends with: ...{(await result.stdout_str()).strip()[-30:]}")
    print(f"  Stats: {ops_summary()}")

    # ── || chain: grep nonexistent || echo fallback ──
    print("\n--- grep NONEXISTENT /s3/data/example.jsonl"
          " || echo 'not found' ---")
    result = await ws.execute(
        "grep NONEXISTENT /s3/data/example.jsonl || echo not_found")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── subshell: (grep | sort | uniq) | wc -l ──
    print("\n--- (grep queue-operation /s3/data/example.jsonl"
          " | sort | uniq) | wc -l ---")
    result = await ws.execute(
        "(grep queue-operation /s3/data/example.jsonl | sort | uniq) | wc -l")
    print(f"  Unique queue ops: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── semicolon: multiple independent reads ──
    print("\n--- head -n 1 /s3/data/example.jsonl"
          " ; wc -l /s3/data/example.jsonl ---")
    result = await ws.execute(
        "head -n 1 /s3/data/example.jsonl ; wc -l /s3/data/example.jsonl")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── lazy multi-pipe: grep | grep | head | cut ──
    # Each pipe stage is an AsyncIterator[bytes]. Data streams lazily
    # from S3 through grep → grep → head → cut.  When head -n 2 has
    # emitted 2 lines it stops pulling, which back-pressures upstream:
    # the second grep stops, the first grep stops, and the S3 download
    # is abandoned early — only a fraction of the file is ever read.
    print("\n--- lazy multi-pipe: grep | grep -v | head | cut ---")
    result = await ws.execute("grep queue-operation /s3/data/example.jsonl"
                              " | grep -v error | head -n 2 | cut -d , -f 1")
    print(f"  Output:\n    {(await result.stdout_str()).strip()}")

    # Compare: same pipeline without head reads the entire file
    result_full = await ws.execute(
        "grep queue-operation /s3/data/example.jsonl"
        " | grep -v error | cut -d , -f 1")
    full_lines = (await result_full.stdout_str()).strip().splitlines()
    print(f"  Without head: {len(full_lines)} lines (full S3 download)")

    # ── recursive search ──
    print("\n--- rg -l mirage /s3/data ---")
    output = await (await ws.execute("rg -l mirage /s3/data")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Files: {lines}")
    print(f"  Stats: {ops_summary()}")

    # ── jq: structured JSON queries ──
    print("\n=== JQ QUERIES ===\n")

    print("--- jq .metadata ---")
    result = await ws.execute("jq .metadata /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all team names (nested [] iterator) ---")
    result = await ws.execute(
        "jq \".departments[].teams[].name\" /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all employee names ---")
    result = await ws.execute("jq \".departments[].teams[].members[].name\""
                              " /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: senior engineers on platform ---")
    result = await ws.execute("jq \".departments[0].teams[0].members"
                              " | map(select(.level == \\\"senior\\\"))"
                              " | map(.name)\" /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all active project names ---")
    result = await ws.execute("jq \".departments[].teams[].projects"
                              " | map(select(.status == \\\"active\\\"))"
                              " | map(.name)\" /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: mirage project metrics ---")
    result = await ws.execute("jq .departments[0].teams[0].projects[0].metrics"
                              " /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: total budget ---")
    result = await ws.execute("jq .metadata.total_budget /s3/data/example.json"
                              )
    print(f"  Total budget: ${int((await result.stdout_str()).strip()):,}")

    print("\n--- jq: vendor costs ---")
    result = await ws.execute(
        "jq \".vendor_contracts | map(.annual_cost)\" /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: office locations ---")
    result = await ws.execute(
        "jq \".locations | map(.city)\" /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all incident titles ---")
    result = await ws.execute("jq \".departments[].teams[].incidents[].title\""
                              " /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: OKR key results ---")
    result = await ws.execute("jq \".okrs[0].objectives[0].key_results"
                              " | map(.description)\" /s3/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- pipe: cat | jq (from cache) ---")
    result = await ws.execute(
        "cat /s3/data/example.json | jq .metadata.version")
    print(f"  Version: {(await result.stdout_str()).strip()}")

    # ── session: cd + export ──
    print("\n=== SESSION: cd + export ===\n")

    print("--- cd /s3/data && ls ---")
    await ws.execute("cd /s3/data")
    result = await ws.execute("ls")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- export + variable expansion ---")
    await ws.execute("export SEARCH=mirage")
    result = await ws.execute("grep $SEARCH example.jsonl | head -n 2")
    print(f"  {(await result.stdout_str()).strip()[:80]}...")

    print("\n--- printenv ---")
    result = await ws.execute("printenv")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- plan: cd + grep ---")
    await ws.execute("cd /s3/data")
    dr = await ws.execute("grep mirage example.jsonl", provision=True)
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")

    # ── execution history: structured observability ──
    print("\n=== EXECUTION HISTORY ===\n")
    print(f"  Total commands recorded: {len(ws.history.entries())}")

    entry = ws.history.entries()[-1]
    print(f"\n  Last command: {entry.command}")
    print(f"  Agent: {entry.agent}")
    print(f"  Exit code: {entry.exit_code}")

    def print_tree(node, indent=4):
        prefix = " " * indent
        if node.command:
            stderr_str = node.stderr.decode(errors="replace").strip()
            print(f"{prefix}{node.command}  "
                  f"exit={node.exit_code}"
                  f"{f'  stderr={stderr_str!r}' if stderr_str else ''}")
        else:
            print(f"{prefix}({node.op})  exit={node.exit_code}")
        for child in node.children:
            print_tree(child, indent + 2)

    print("\n  --- pipe tree: grep | grep -v | head | cut ---")
    await ws.execute(
        "grep queue-operation /s3/data/example.jsonl"
        " | grep -v error | head -n 2 | cut -d , -f 1",
        agent_id="demo-agent",
    )
    pipe_entry = ws.history.entries()[-1]
    print_tree(pipe_entry.tree)

    print("\n  --- error attribution: grep NONEXISTENT | sort | head ---")
    await ws.execute(
        "grep NONEXISTENT /s3/data/example.jsonl | sort | head -n 5",
        agent_id="demo-agent",
    )
    err_entry = ws.history.entries()[-1]
    print_tree(err_entry.tree)
    print(f"    Top-level exit: {err_entry.exit_code}")
    for child in err_entry.tree.children:
        if child.exit_code != 0:
            print(
                f"    ^ failed stage: {child.command} (exit={child.exit_code})"
            )

    print("\n  --- control flow tree: grep && echo ; wc -l ---")
    await ws.execute(
        "grep -m 1 mirage /s3/data/example.jsonl && echo found"
        " ; wc -l /s3/data/example.jsonl",
        agent_id="demo-agent",
    )
    cf_entry = ws.history.entries()[-1]
    print_tree(cf_entry.tree)

    print("\n  --- full history (all commands) ---")
    for i, e in enumerate(ws.history.entries()):
        print(f"  [{i}] {e.command[:70]}")
        print(f"      agent={e.agent}  exit={e.exit_code}  "
              f"stdout={len(e.stdout)}B")
        if e.tree.children:
            for child in e.tree.children:
                stderr_str = child.stderr.decode(errors="replace").strip()
                label = child.command or f"({child.op})"
                print(
                    f"        {label}  exit={child.exit_code}"
                    f"{'  stderr=' + repr(stderr_str) if stderr_str else ''}")

    print("\n  --- history as JSONL ---")
    for e in ws.history.entries():
        print(json.dumps(e.to_dict(), separators=(",", ":")))

    # ── background jobs: & operator ──
    print("\n=== BACKGROUND JOBS ===\n")

    print("--- launch two background greps ---")
    r = await ws.execute(
        "grep mirage /s3/data/example.jsonl &"
        " grep queue-operation /s3/data/example.jsonl &",
        agent_id="demo-agent",
    )
    print(f"  Output: {(await r.stdout_str()).strip()}")

    print("\n--- ps: show running jobs ---")
    r = await ws.execute("ps u")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- jobs: list all ---")
    r = await ws.execute("jobs")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- wait %1: get first grep result ---")
    r = await ws.execute("wait %1")
    lines = (await r.stdout_str()).strip().splitlines() if (
        await r.stdout_str()).strip() else []
    print(f"  Matches: {len(lines)}, exit_code: {r.exit_code}")
    if lines:
        print(f"  First: {lines[0][:80]}...")

    print("\n--- wait %2: get second grep result ---")
    r = await ws.execute("wait %2")
    lines = (await r.stdout_str()).strip().splitlines() if (
        await r.stdout_str()).strip() else []
    print(f"  Matches: {len(lines)}, exit_code: {r.exit_code}")

    print("\n--- background pipe: grep | head & ---")
    await ws.execute(
        "grep queue-operation /s3/data/example.jsonl | head -n 3 &")
    r = await ws.execute("wait %3")
    print(f"  Output:\n    {(await r.stdout_str()).strip()}")

    print("\n--- kill demo ---")
    await ws.execute("grep mirage /s3/data/example.jsonl &")
    await ws.execute("kill %4")
    r = await ws.execute("wait %4")
    print(f"  Exit code after kill: {r.exit_code}")

    print("\n--- wait || fallback pattern ---")
    await ws.execute("grep NONEXISTENT /s3/data/example.jsonl &")
    await ws.execute("grep mirage /s3/data/example.jsonl &")
    r = await ws.execute("wait %5 || wait %6")
    lines = (await r.stdout_str()).strip().splitlines() if (
        await r.stdout_str()).strip() else []
    print(f"  Fallback matches: {len(lines)}")

    print("\n--- jobs after all done ---")
    r = await ws.execute("jobs")
    print(f"  {(await r.stdout_str()).strip() or '(empty)'}")

    print("\n--- background job history ---")
    bg_entries = [
        e for e in ws.history.entries()
        if "grep" in e.command and "&" not in e.command
    ]
    print(f"  Background job records: {len(bg_entries)}")
    for e in bg_entries[-4:]:
        print(f"    {e.command[:60]}  exit={e.exit_code}")

    # ── session observer: /.sessions mount ──
    print("\n=== GLOB EXPANSION ===\n")

    print("--- echo /s3/data/*.jsonl ---")
    r = await ws.execute("echo /s3/data/*.jsonl")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- ls /s3/data/*.json ---")
    r = await ws.execute("ls /s3/data/*.json")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- for f in /s3/data/*.json; do wc -l $f; done ---")
    r = await ws.execute("for f in /s3/data/*.json; do wc -l $f; done")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- grep mirage /s3/data/*.jsonl | head -n 2 ---")
    r = await ws.execute("grep mirage /s3/data/*.jsonl | head -n 2")
    for line in (await r.stdout_str()).strip().splitlines():
        print(f"  {line[:100]}")

    print("\n=== SESSION OBSERVER ===\n")

    print("--- ls /.sessions ---")
    result = await ws.execute("ls /.sessions")
    print(f"  {(await result.stdout_str()).strip()}")

    from mirage.utils.dates import utc_date_folder
    day = utc_date_folder()
    print(f"\n--- cat /.sessions/{day}/*.jsonl | head -n 5 ---")
    result = await ws.execute(f"head -n 5 /.sessions/{day}/*.jsonl")
    for line in (await result.stdout_str()).strip().splitlines():
        print(f"  {line[:120]}")

    # ── cross-mount mv: RAM → S3 (with cleanup) ──────────────────────
    # Builds a fresh workspace with RAM at /local/ and S3 at /s3/ in
    # WRITE mode. Creates a unique a.txt in RAM via tee, mvs it to S3,
    # verifies it landed there, then removes it from S3 so the bucket
    # is left clean.
    print("\n=== CROSS-MOUNT MV: RAM → S3 ===\n")
    mv_ws = Workspace(
        {
            "/local/": (RAMResource(), MountMode.WRITE),
            "/s3/": (S3Resource(config), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )
    remote = f"/s3/_mv_test/{uuid.uuid4().hex[:8]}_a.txt"
    payload = "hello from RAM\n"
    print(f"  target: {remote}")
    try:
        r = await mv_ws.execute(f'echo "{payload.rstrip()}" | tee /local/a.txt'
                                )
        print(f"  tee exit={r.exit_code} (created /local/a.txt)")

        r = await mv_ws.execute(f"mv /local/a.txt {remote}")
        print(f"  mv exit={r.exit_code} "
              f"stderr={(await r.stderr_str()).strip()!r}")

        r = await mv_ws.execute(f"cat {remote}")
        got = await r.stdout_str()
        ok = got == payload
        print(f"  S3 read back: {got!r} ({'OK' if ok else 'MISMATCH'})")

        r = await mv_ws.execute("cat /local/a.txt")
        print(f"  RAM source after mv: exit={r.exit_code} "
              f"(expect non-zero — file moved away)")
    finally:
        r = await mv_ws.execute(f"rm {remote}")
        print(f"  cleanup rm exit={r.exit_code}")
        r = await mv_ws.execute(f"cat {remote}")
        print(f"  S3 read after rm: exit={r.exit_code} (expect non-zero)")

    # ── persistence: save / load / copy / deepcopy ──────────────────
    # S3 has needs_override=True — creds are redacted at save time;
    # caller must re-supply a fresh S3Resource via resources={...}.
    print("\n=== PERSISTENCE ===\n")
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as f:
        snap = f.name
    try:
        await ws.snapshot(snap)
        size = os.path.getsize(snap)
        print(f"  saved → {snap} ({size} bytes)")

        # Verify creds are NOT in the raw tar bytes
        raw = open(snap, "rb").read()
        leaked = config.aws_access_key_id and (
            config.aws_access_key_id.encode() in raw)
        print(f"  creds leaked in tar bytes: {bool(leaked)} "
              f"(expect False)")
        print(f"  '<REDACTED>' present in tar: "
              f"{b'<REDACTED>' in raw} (expect True)")

        # Loading without resources= must fail fast
        try:
            Workspace.load(snap)
            print("  ✗ load() should have raised without resources=")
        except ValueError as e:
            print(f"  ✓ load() w/o resources raises: "
                  f"{str(e).splitlines()[0][:70]}…")

        # Load with fresh creds
        loaded = Workspace.load(snap, resources={"/s3/": S3Resource(config)})
        r = await loaded.execute("ls /s3/")
        print(f"  loaded ws ls /s3/: "
              f"{(await r.stdout_str()).strip()[:60]}…")

        # copy(): in-process, reuses the same S3Resource; both copies
        # see the same bucket
        cp = await ws.copy()
        print(f"  copy() mounts: {[m.prefix for m in cp.mounts()]}")

        for op_name, op in (("deepcopy", _copy.deepcopy), ("shallow copy",
                                                           _copy.copy)):
            try:
                op(ws)
                print(f"  ✗ {op_name} should have raised")
            except NotImplementedError as e:
                print(f"  ✓ {op_name} raises: {str(e)[:60]}…")
    finally:
        os.unlink(snap)

    print("\n=== DRIFT + VERSION PIN ===\n")
    print("  requires bucket versioning enabled:")
    print("  aws s3api put-bucket-versioning --bucket <bucket> "
          "--versioning-configuration Status=Enabled\n")
    probe = f"/s3/drift-probe-{uuid.uuid4().hex[:8]}.txt"
    drift_ws = Workspace({"/s3/": (S3Resource(config), MountMode.WRITE)},
                         mode=MountMode.WRITE)
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as f:
        drift_snap = f.name
    try:
        await drift_ws.execute(f'echo "original" | tee {probe}')
        await drift_ws.execute(f"cat {probe}")
        s = await drift_ws.stat(probe)
        print(f"  wrote {probe}")
        print(f"  fingerprint={s.fingerprint}")
        print(f"  revision   ={s.revision} "
              f"({'versioning on' if s.revision else 'no versioning'})")

        await drift_ws.snapshot(drift_snap)
        snap_size = os.path.getsize(drift_snap)
        print(f"  snapshot: {drift_snap} ({snap_size} bytes)")

        await drift_ws.execute(f'echo "mutated" | tee {probe}')
        s2 = await drift_ws.stat(probe)
        print(f"  mutated on bucket: new revision={s2.revision}")

        loaded = Workspace.load(drift_snap,
                                resources={"/s3/": S3Resource(config)})
        loaded._cache.evict_paths([probe])
        try:
            r = await loaded.execute(f"cat {probe}")
            served = (await r.stdout_str()).strip()
            pinned_ok = s.revision is not None and served == "original"
            label = ("OK pin served original" if pinned_ok else
                     "no pin (bucket not versioned?), live fingerprint matched"
                     if served == "original" else "UNEXPECTED")
            print(f"  STRICT load → served: {served!r} ({label})")
        except ContentDriftError as e:
            print(f"  STRICT load raised ContentDriftError as expected: "
                  f"{e.path}")
    finally:
        try:
            await drift_ws.execute(f"rm {probe}")
        except Exception:
            pass
        if os.path.exists(drift_snap):
            os.unlink(drift_snap)


asyncio.run(main())
