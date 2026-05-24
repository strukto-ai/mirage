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
import json
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.gdrive import GoogleDriveConfig, GoogleDriveResource

load_dotenv(".env.development")

config = GoogleDriveConfig(
    client_id=os.environ["GOOGLE_CLIENT_ID"],
    client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
    refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
)

backend = GoogleDriveResource(config=config)
ws = Workspace({"/gdrive/": backend}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


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


async def main():
    # ── prime the cache: gdrive resolves paths via file IDs ──
    await ws.execute("ls /gdrive/")
    await ws.execute("ls /gdrive/mirage/")

    # ── plan: estimate before executing ──
    print("=== PLAN ESTIMATES ===\n")

    dr = await ws.execute("grep mirage /gdrive/mirage/example.jsonl",
                          provision=True)
    print("--- plan: grep mirage /gdrive/mirage/example.jsonl ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  read_ops: {dr.read_ops}, precision: {dr.precision}")

    dr = await ws.execute(
        "grep mirage /gdrive/mirage/example.jsonl | head -n 3", provision=True)
    print("\n--- plan: grep mirage ... | head -n 3 ---")
    print(f"  op: {dr.op}, children: {len(dr.children)}")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  precision: {dr.precision}")
    for c in dr.children:
        net, cache = c.network_read, c.cache_read
        print(f"    {c.command}: net={net}, cache={cache}, {c.precision}")

    dr = await ws.execute(
        "grep mirage /gdrive/mirage/example.jsonl && echo found",
        provision=True)
    print("\n--- plan: grep ... && echo found ---")
    print(f"  op: {dr.op}, network_read: {dr.network_read}")
    for c in dr.children:
        print(f"    {c.command}: net={c.network_read}, {c.precision}")

    print(f"\n  Stats after plans (should be 0): {ops_summary()}")

    # ── cache-aware plan ──
    print("\n--- caching: cat /gdrive/mirage/example.jsonl | wc -l ---")
    result = await ws.execute("cat /gdrive/mirage/example.jsonl | wc -l")
    print(f"  lines: {(await result.stdout_str()).strip()}")
    print(f"  Stats after caching: {ops_summary()}")

    dr = await ws.execute("grep mirage /gdrive/mirage/example.jsonl",
                          provision=True)
    print("\n--- plan after cache: grep mirage ... ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  cache_hits: {dr.cache_hits}, read_ops: {dr.read_ops}")

    print("\n=== ACTUAL EXECUTION ===\n")

    # ── simple grep ──
    print("--- grep mirage /gdrive/mirage/example.jsonl ---")
    output = await (
        await
        ws.execute("grep mirage /gdrive/mirage/example.jsonl")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    if lines:
        print(f"  First: {lines[0][:80]}...")
    print(f"  Stats: {ops_summary()}")

    # ── grep with limit ──
    print("\n--- grep -m 1 mirage /gdrive/mirage/example.jsonl ---")
    output = await (await
                    ws.execute("grep -m 1 mirage /gdrive/mirage/example.jsonl")
                    ).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: grep | wc -l ──
    print("\n--- grep mirage /gdrive/mirage/example.jsonl | wc -l ---")
    result = await ws.execute(
        "grep mirage /gdrive/mirage/example.jsonl | wc -l")
    print(f"  Count: {(await result.stdout_str()).strip()}")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: grep | head ──
    print("\n--- grep mirage /gdrive/mirage/example.jsonl | head -n 3 ---")
    result = await ws.execute(
        "grep mirage /gdrive/mirage/example.jsonl | head -n 3")
    lines = (await result.stdout_str()).strip().splitlines()
    print(f"  Lines: {len(lines)}")
    for ln in lines:
        print(f"    {ln[:80]}...")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: cat | grep | sort | uniq ──
    print("\n--- cat /gdrive/mirage/example.jsonl"
          " | grep queue-operation | sort | uniq ---")
    result = await ws.execute("cat /gdrive/mirage/example.jsonl"
                              " | grep queue-operation | sort | uniq")
    lines = ((await result.stdout_str()).strip().splitlines() if
             (await result.stdout_str()).strip() else [])
    print(f"  Unique lines: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    # ── pipe: grep | cut (extract field) ──
    print("\n--- rg queue-operation /gdrive/mirage/example.jsonl"
          " | head -n 5 | cut -d , -f 2 ---")
    result = await ws.execute("rg queue-operation /gdrive/mirage/example.jsonl"
                              " | head -n 5 | cut -d , -f 2")
    print(f"  Fields:\n    {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── && chain: grep && echo ──
    print("\n--- grep -m 1 mirage /gdrive/mirage/example.jsonl"
          " && echo 'found mirage' ---")
    result = await ws.execute(
        "grep -m 1 mirage /gdrive/mirage/example.jsonl && echo found")
    print(f"  Exit code: {result.exit_code}")
    print(
        f"  Stdout ends with: ...{(await result.stdout_str()).strip()[-30:]}")
    print(f"  Stats: {ops_summary()}")

    # ── || chain: grep nonexistent || echo fallback ──
    print("\n--- grep NONEXISTENT /gdrive/mirage/example.jsonl"
          " || echo 'not found' ---")
    result = await ws.execute(
        "grep NONEXISTENT /gdrive/mirage/example.jsonl || echo not_found")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── subshell: (grep | sort | uniq) | wc -l ──
    print("\n--- (grep queue-operation /gdrive/mirage/example.jsonl"
          " | sort | uniq) | wc -l ---")
    result = await ws.execute(
        "(grep queue-operation /gdrive/mirage/example.jsonl"
        " | sort | uniq) | wc -l")
    print(f"  Unique queue ops: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── semicolon: multiple independent reads ──
    print("\n--- head -n 1 /gdrive/mirage/example.jsonl"
          " ; wc -l /gdrive/mirage/example.jsonl ---")
    result = await ws.execute("head -n 1 /gdrive/mirage/example.jsonl"
                              " ; wc -l /gdrive/mirage/example.jsonl")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    # ── lazy multi-pipe: grep | grep | head | cut ──
    print("\n--- lazy multi-pipe: grep | grep -v | head | cut ---")
    result = await ws.execute(
        "grep queue-operation /gdrive/mirage/example.jsonl"
        " | grep -v error | head -n 2 | cut -d , -f 1")
    print(f"  Output:\n    {(await result.stdout_str()).strip()}")

    result_full = await ws.execute(
        "grep queue-operation /gdrive/mirage/example.jsonl"
        " | grep -v error | cut -d , -f 1")
    full_lines = (await result_full.stdout_str()).strip().splitlines()
    print(f"  Without head: {len(full_lines)} lines (full download)")

    # ── recursive search ──
    print("\n--- rg -l mirage /gdrive/mirage ---")
    output = await (await
                    ws.execute("rg -l mirage /gdrive/mirage")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Files: {lines}")
    print(f"  Stats: {ops_summary()}")

    # ── Google native files: docs, sheets, slides ──
    print("\n=== GOOGLE NATIVE FILES ===\n")

    print("--- ls /gdrive (find native files) ---")
    r = await ws.execute("ls /gdrive/ | head -n 20")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- grep in Google Docs (.gdoc.json) ---")
    r = await ws.execute("ls /gdrive/")
    listing = (await r.stdout_str()).strip().splitlines()
    gdoc = next((f.strip() for f in listing if ".gdoc.json" in f), None)
    if gdoc:
        print(f"  Found doc: {gdoc}")
        r = await ws.execute(f'grep -i "title" "/gdrive/{gdoc}"')
        out = (await r.stdout_str()).strip()
        if out:
            print(f"  grep title: {out[:120]}...")
        print(f"  Stats: {ops_summary()}")
    else:
        print("  No .gdoc.json found in /gdrive/")

    gsheet = next((f.strip() for f in listing if ".gsheet.json" in f), None)
    if gsheet:
        print("\n--- grep in Google Sheets (.gsheet.json) ---")
        print(f"  Found sheet: {gsheet}")
        r = await ws.execute(
            f'grep -i "properties" "/gdrive/{gsheet}" | head -n 3')
        out = (await r.stdout_str()).strip()
        if out:
            print(f"  grep properties: {out[:120]}...")
        print(f"  Stats: {ops_summary()}")

    gslide = next((f.strip() for f in listing if ".gslide.json" in f), None)
    if gslide:
        print("\n--- grep in Google Slides (.gslide.json) ---")
        print(f"  Found slide: {gslide}")
        r = await ws.execute(f'grep -i "slide" "/gdrive/{gslide}" | head -n 3')
        out = (await r.stdout_str()).strip()
        if out:
            print(f"  grep slide: {out[:120]}...")
        print(f"  Stats: {ops_summary()}")

    # ── mixed file type grep ──
    print("\n=== MIXED FILE TYPE GREP ===\n")

    print("--- grep -c title in Google Doc (eager read) ---")
    if gdoc:
        r = await ws.execute(f'grep -c title "/gdrive/{gdoc}"')
        print(f"  {gdoc}: {(await r.stdout_str()).strip()} matches")

    print("\n--- grep in regular file (streaming) ---")
    r = await ws.execute("grep -c queue-operation /gdrive/mirage/example.jsonl"
                         )
    print(f"  example.jsonl: {(await r.stdout_str()).strip()} matches")

    print("\n--- rg across mirage folder (regular files) ---")
    r = await ws.execute("rg -l queue /gdrive/mirage/")
    files = (await r.stdout_str()).strip().splitlines()
    print(f"  Files matching 'queue': {files}")
    print(f"  Stats: {ops_summary()}")

    # ── filetype: parquet, orc, feather, hdf5 ──
    print("\n=== FILETYPE: parquet, orc, feather, hdf5 ===\n")

    for label, path in [
        ("parquet", "/gdrive/mirage/example.parquet"),
        ("orc", "/gdrive/mirage/example.orc"),
        ("feather", "/gdrive/mirage/example.feather"),
        ("hdf5", "/gdrive/mirage/example.h5"),
    ]:
        print(f"--- cat {label} | grep item_5 ---")
        r = await ws.execute(f"cat {path} | grep item_5")
        print(f"  exit={r.exit_code}  {(await r.stdout_str()).strip()[:100]}")

    print("\n--- cat parquet | head -n 3 ---")
    r = await ws.execute("cat /gdrive/mirage/example.parquet | head -n 3")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n--- wc -l across formats ---")
    for label, path in [
        ("parquet", "/gdrive/mirage/example.parquet"),
        ("orc", "/gdrive/mirage/example.orc"),
        ("feather", "/gdrive/mirage/example.feather"),
        ("hdf5", "/gdrive/mirage/example.h5"),
    ]:
        r = await ws.execute(f"wc -l {path}")
        print(f"  {label}: {(await r.stdout_str()).strip()}")

    print(f"  Stats: {ops_summary()}")

    # ── jq: structured JSON queries ──
    print("\n=== JQ QUERIES ===\n")

    print("--- jq .metadata ---")
    result = await ws.execute("jq .metadata /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all team names (nested [] iterator) ---")
    result = await ws.execute(
        "jq \".departments[].teams[].name\" /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all employee names ---")
    result = await ws.execute("jq \".departments[].teams[].members[].name\""
                              " /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: senior engineers on platform ---")
    result = await ws.execute("jq \".departments[0].teams[0].members"
                              " | map(select(.level == \\\"senior\\\"))"
                              " | map(.name)\" /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all active project names ---")
    result = await ws.execute("jq \".departments[].teams[].projects"
                              " | map(select(.status == \\\"active\\\"))"
                              " | map(.name)\" /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: mirage project metrics ---")
    result = await ws.execute("jq .departments[0].teams[0].projects[0].metrics"
                              " /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: total budget ---")
    result = await ws.execute(
        "jq .metadata.total_budget /gdrive/mirage/example.json")
    budget = (await result.stdout_str()).strip()
    if budget:
        print(f"  Total budget: ${int(budget):,}")
    else:
        print("  (no output)")

    print("\n--- jq: vendor costs ---")
    result = await ws.execute("jq \".vendor_contracts | map(.annual_cost)\""
                              " /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: office locations ---")
    result = await ws.execute(
        "jq \".locations | map(.city)\" /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all incident titles ---")
    result = await ws.execute("jq \".departments[].teams[].incidents[].title\""
                              " /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: OKR key results ---")
    result = await ws.execute(
        "jq \".okrs[0].objectives[0].key_results"
        " | map(.description)\" /gdrive/mirage/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- pipe: cat | jq (from cache) ---")
    result = await ws.execute(
        "cat /gdrive/mirage/example.json | jq .metadata.version")
    print(f"  Version: {(await result.stdout_str()).strip()}")

    # ── session: cd + export ──
    print("\n=== SESSION: cd + export ===\n")

    print("--- cd /gdrive/mirage && ls ---")
    await ws.execute("cd /gdrive/mirage")
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
    await ws.execute("cd /gdrive/mirage")
    dr = await ws.execute("grep mirage example.jsonl", provision=True)
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")

    # ── execution history: structured observability ──
    print("\n=== EXECUTION HISTORY ===\n")
    print(f"  Total commands recorded: {len(ws.history.entries())}")

    entry = ws.history.entries()[-1]
    print(f"\n  Last command: {entry.command}")
    print(f"  Agent: {entry.agent}")
    print(f"  Exit code: {entry.exit_code}")

    print("\n  --- pipe tree: grep | grep -v | head | cut ---")
    await ws.execute(
        "grep queue-operation /gdrive/mirage/example.jsonl"
        " | grep -v error | head -n 2 | cut -d , -f 1",
        agent_id="demo-agent",
    )
    pipe_entry = ws.history.entries()[-1]
    print_tree(pipe_entry.tree)

    print("\n  --- error attribution: grep NONEXISTENT | sort | head ---")
    await ws.execute(
        "grep NONEXISTENT /gdrive/mirage/example.jsonl | sort | head -n 5",
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
        "grep -m 1 mirage /gdrive/mirage/example.jsonl && echo found"
        " ; wc -l /gdrive/mirage/example.jsonl",
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
        "grep mirage /gdrive/mirage/example.jsonl &"
        " grep queue-operation /gdrive/mirage/example.jsonl &",
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
        "grep queue-operation /gdrive/mirage/example.jsonl | head -n 3 &")
    r = await ws.execute("wait %3")
    print(f"  Output:\n    {(await r.stdout_str()).strip()}")

    print("\n--- kill demo ---")
    await ws.execute("grep mirage /gdrive/mirage/example.jsonl &")
    await ws.execute("kill %4")
    r = await ws.execute("wait %4")
    print(f"  Exit code after kill: {r.exit_code}")

    print("\n--- wait || fallback pattern ---")
    await ws.execute("grep NONEXISTENT /gdrive/mirage/example.jsonl &")
    await ws.execute("grep mirage /gdrive/mirage/example.jsonl &")
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


asyncio.run(main())
