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
from mirage.resource.r2 import R2Config, R2Resource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = R2Config(
    bucket=os.environ["R2_BUCKET"],
    account_id=os.environ.get("R2_ACCOUNT_ID"),
    endpoint_url=os.environ.get("R2_ENDPOINT_URL"),
    access_key_id=os.environ["R2_ACCESS_KEY_ID"],
    secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    region=os.environ.get("R2_REGION", "auto"),
)

backend = R2Resource(config)
ws = Workspace({"/r2/": backend}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    print("=== PLAN ESTIMATES ===\n")

    dr = await ws.execute("grep mirage /r2/data/example.jsonl", provision=True)
    print("--- plan: grep mirage /r2/data/example.jsonl ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  read_ops: {dr.read_ops}, precision: {dr.precision}")

    dr = await ws.execute("grep mirage /r2/data/example.jsonl | head -n 3",
                          provision=True)
    print("\n--- plan: grep mirage ... | head -n 3 ---")
    print(f"  op: {dr.op}, children: {len(dr.children)}")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  precision: {dr.precision}")
    for c in dr.children:
        net, cache = c.network_read, c.cache_read
        print(f"    {c.command}: net={net}, cache={cache}, {c.precision}")

    dr = await ws.execute("grep mirage /r2/data/example.jsonl && echo found",
                          provision=True)
    print("\n--- plan: grep ... && echo found ---")
    print(f"  op: {dr.op}, network_read: {dr.network_read}")
    for c in dr.children:
        print(f"    {c.command}: net={c.network_read}, {c.precision}")

    print(f"\n  Stats after plans (should be 0): {ops_summary()}")

    print("\n--- caching: cat /r2/data/example.jsonl | wc -l ---")
    result = await ws.execute("cat /r2/data/example.jsonl | wc -l")
    print(f"  lines: {(await result.stdout_str()).strip()}")
    print(f"  Stats after caching: {ops_summary()}")

    dr = await ws.execute("grep mirage /r2/data/example.jsonl", provision=True)
    print("\n--- plan after cache: grep mirage ... ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  cache_hits: {dr.cache_hits}, read_ops: {dr.read_ops}")

    print("\n=== ACTUAL EXECUTION ===\n")

    print("--- grep mirage /r2/data/example.jsonl ---")
    output = await (
        await ws.execute("grep mirage /r2/data/example.jsonl")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    if lines:
        print(f"  First: {lines[0][:80]}...")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep -m 1 mirage /r2/data/example.jsonl ---")
    output = await (
        await
        ws.execute("grep -m 1 mirage /r2/data/example.jsonl")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep mirage /r2/data/example.jsonl | wc -l ---")
    result = await ws.execute("grep mirage /r2/data/example.jsonl | wc -l")
    print(f"  Count: {(await result.stdout_str()).strip()}")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep mirage /r2/data/example.jsonl | head -n 3 ---")
    result = await ws.execute("grep mirage /r2/data/example.jsonl | head -n 3")
    lines = (await result.stdout_str()).strip().splitlines()
    print(f"  Lines: {len(lines)}")
    for ln in lines:
        print(f"    {ln[:80]}...")
    print(f"  Stats: {ops_summary()}")

    print("\n--- cat /r2/data/example.jsonl"
          " | grep queue-operation | sort | uniq ---")
    result = await ws.execute(
        "cat /r2/data/example.jsonl | grep queue-operation | sort | uniq")
    lines = ((await result.stdout_str()).strip().splitlines() if
             (await result.stdout_str()).strip() else [])
    print(f"  Unique lines: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- rg queue-operation /r2/data/example.jsonl"
          " | head -n 5 | cut -d , -f 2 ---")
    result = await ws.execute(
        "rg queue-operation /r2/data/example.jsonl | head -n 5 | cut -d , -f 2"
    )
    print(f"  Fields:\n    {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep -m 1 mirage /r2/data/example.jsonl"
          " && echo 'found mirage' ---")
    result = await ws.execute(
        "grep -m 1 mirage /r2/data/example.jsonl && echo found")
    print(f"  Exit code: {result.exit_code}")
    print(
        f"  Stdout ends with: ...{(await result.stdout_str()).strip()[-30:]}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep NONEXISTENT /r2/data/example.jsonl"
          " || echo 'not found' ---")
    result = await ws.execute(
        "grep NONEXISTENT /r2/data/example.jsonl || echo not_found")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- (grep queue-operation /r2/data/example.jsonl"
          " | sort | uniq) | wc -l ---")
    result = await ws.execute(
        "(grep queue-operation /r2/data/example.jsonl | sort | uniq) | wc -l")
    print(f"  Unique queue ops: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- head -n 1 /r2/data/example.jsonl"
          " ; wc -l /r2/data/example.jsonl ---")
    result = await ws.execute(
        "head -n 1 /r2/data/example.jsonl ; wc -l /r2/data/example.jsonl")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- lazy multi-pipe: grep | grep -v | head | cut ---")
    result = await ws.execute("grep queue-operation /r2/data/example.jsonl"
                              " | grep -v error | head -n 2 | cut -d , -f 1")
    print(f"  Output:\n    {(await result.stdout_str()).strip()}")

    result_full = await ws.execute(
        "grep queue-operation /r2/data/example.jsonl"
        " | grep -v error | cut -d , -f 1")
    full_lines = (await result_full.stdout_str()).strip().splitlines()
    print(f"  Without head: {len(full_lines)} lines (full R2 download)")

    print("\n--- rg -l mirage /r2/data ---")
    output = await (await ws.execute("rg -l mirage /r2/data")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Files: {lines}")
    print(f"  Stats: {ops_summary()}")

    print("\n=== JQ QUERIES ===\n")

    print("--- jq .metadata ---")
    result = await ws.execute("jq .metadata /r2/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all team names (nested [] iterator) ---")
    result = await ws.execute(
        "jq \".departments[].teams[].name\" /r2/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all employee names ---")
    result = await ws.execute("jq \".departments[].teams[].members[].name\""
                              " /r2/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: senior engineers on platform ---")
    result = await ws.execute("jq \".departments[0].teams[0].members"
                              " | map(select(.level == \\\"senior\\\"))"
                              " | map(.name)\" /r2/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all active project names ---")
    result = await ws.execute("jq \".departments[].teams[].projects"
                              " | map(select(.status == \\\"active\\\"))"
                              " | map(.name)\" /r2/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: mirage project metrics ---")
    result = await ws.execute("jq .departments[0].teams[0].projects[0].metrics"
                              " /r2/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: total budget ---")
    result = await ws.execute("jq .metadata.total_budget /r2/data/example.json"
                              )
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: compact JSON row ---")
    result = await ws.execute("jq -c .metadata /r2/data/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: departments pretty json ---")
    result = await ws.execute("jq .departments /r2/data/example.json")
    parsed = json.loads(await result.stdout_str())
    print(f"  departments: {len(parsed)}")
    print(f"  first team: {parsed[0]['teams'][0]['name']}")

    # chmod/chown/touch never hit the R2 API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /r2/data/example.jsonl ===")
    meta_res = await ws.execute(
        'chmod 640 "/r2/data/example.jsonl"'
        ' && chown 500:dev "/r2/data/example.jsonl"'
        ' && touch -t 202601021530 "/r2/data/example.jsonl"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/r2/data/example.jsonl"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")


if __name__ == "__main__":
    asyncio.run(main())
