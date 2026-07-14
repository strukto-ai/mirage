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
from mirage.resource.supabase import SupabaseConfig, SupabaseResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = SupabaseConfig(
    bucket=os.environ["SUPABASE_BUCKET"],
    project_ref=os.environ.get("SUPABASE_PROJECT_REF"),
    endpoint_url=os.environ.get("SUPABASE_ENDPOINT_URL"),
    region=os.environ["SUPABASE_REGION"],
    access_key_id=os.environ["SUPABASE_ACCESS_KEY_ID"],
    secret_access_key=os.environ["SUPABASE_SECRET_ACCESS_KEY"],
    session_token=os.environ.get("SUPABASE_SESSION_TOKEN"),
)

backend = SupabaseResource(config)
ws = Workspace({"/supabase/": backend}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    # Free-tier Supabase pauses idle projects; every S3 call then
    # returns HTTP 540. Probe once and report instead of failing
    # cryptically on each section.
    probe = await ws.execute("ls /supabase/")
    if probe.exit_code != 0:
        err = (await probe.stderr_str()).strip()
        print(f"supabase mount unavailable: {err}")
        print("unpause the project in the Supabase dashboard and rerun")
        return

    print("=== PLAN ESTIMATES ===\n")

    dr = await ws.execute(
        "grep mirage /supabase/example.jsonl",
        provision=True,
    )
    print("--- plan: grep mirage /supabase/example.jsonl ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  read_ops: {dr.read_ops}, precision: {dr.precision}")

    dr = await ws.execute(
        "grep mirage /supabase/example.jsonl | head -n 3",
        provision=True,
    )
    print("\n--- plan: grep mirage ... | head -n 3 ---")
    print(f"  op: {dr.op}, children: {len(dr.children)}")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  precision: {dr.precision}")
    for c in dr.children:
        net, cache = c.network_read, c.cache_read
        print(f"    {c.command}: net={net}, cache={cache}, {c.precision}")

    dr = await ws.execute(
        "grep mirage /supabase/example.jsonl && echo found",
        provision=True,
    )
    print("\n--- plan: grep ... && echo found ---")
    print(f"  op: {dr.op}, network_read: {dr.network_read}")
    for c in dr.children:
        print(f"    {c.command}: net={c.network_read}, {c.precision}")

    print(f"\n  Stats after plans (should be 0): {ops_summary()}")

    print("\n--- caching: cat /supabase/example.jsonl | wc -l ---")
    result = await ws.execute("cat /supabase/example.jsonl | wc -l")
    print(f"  lines: {(await result.stdout_str()).strip()}")
    print(f"  Stats after caching: {ops_summary()}")

    dr = await ws.execute("grep mirage /supabase/example.jsonl",
                          provision=True)
    print("\n--- plan after cache: grep mirage ... ---")
    print(f"  network_read: {dr.network_read}, cache_read: {dr.cache_read}")
    print(f"  cache_hits: {dr.cache_hits}, read_ops: {dr.read_ops}")

    print("\n=== ACTUAL EXECUTION ===\n")

    print("--- grep mirage /supabase/example.jsonl ---")
    output = await (
        await ws.execute("grep mirage /supabase/example.jsonl")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    if lines:
        print(f"  First: {lines[0][:80]}...")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep -m 1 mirage /supabase/example.jsonl ---")
    output = await (
        await
        ws.execute("grep -m 1 mirage /supabase/example.jsonl")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Matches: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep mirage /supabase/example.jsonl | wc -l ---")
    result = await ws.execute("grep mirage /supabase/example.jsonl | wc -l")
    print(f"  Count: {(await result.stdout_str()).strip()}")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep mirage /supabase/example.jsonl | head -n 3 ---")
    result = await ws.execute("grep mirage /supabase/example.jsonl | head -n 3"
                              )
    lines = (await result.stdout_str()).strip().splitlines()
    print(f"  Lines: {len(lines)}")
    for ln in lines:
        print(f"    {ln[:80]}...")
    print(f"  Stats: {ops_summary()}")

    print("\n--- cat /supabase/example.jsonl"
          " | grep queue-operation | sort | uniq ---")
    result = await ws.execute(
        "cat /supabase/example.jsonl | grep queue-operation | sort | uniq")
    lines = ((await result.stdout_str()).strip().splitlines() if
             (await result.stdout_str()).strip() else [])
    print(f"  Unique lines: {len(lines)}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- rg queue-operation /supabase/example.jsonl"
          " | head -n 5 | cut -d , -f 2 ---")
    result = await ws.execute("rg queue-operation /supabase/example.jsonl"
                              " | head -n 5 | cut -d , -f 2")
    print(f"  Fields:\n    {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep -m 1 mirage /supabase/example.jsonl"
          " && echo 'found mirage' ---")
    result = await ws.execute(
        "grep -m 1 mirage /supabase/example.jsonl && echo found")
    print(f"  Exit code: {result.exit_code}")
    print(
        f"  Stdout ends with: ...{(await result.stdout_str()).strip()[-30:]}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- grep NONEXISTENT /supabase/example.jsonl"
          " || echo 'not found' ---")
    result = await ws.execute(
        "grep NONEXISTENT /supabase/example.jsonl || echo not_found")
    print(f"  Exit code: {result.exit_code}")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- (grep queue-operation /supabase/example.jsonl"
          " | sort | uniq) | wc -l ---")
    result = await ws.execute(
        "(grep queue-operation /supabase/example.jsonl | sort | uniq)"
        " | wc -l")
    print(f"  Unique queue ops: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- head -n 1 /supabase/example.jsonl"
          " ; wc -l /supabase/example.jsonl ---")
    result = await ws.execute("head -n 1 /supabase/example.jsonl"
                              " ; wc -l /supabase/example.jsonl")
    print(f"  Output: {(await result.stdout_str()).strip()}")
    print(f"  Stats: {ops_summary()}")

    print("\n--- lazy multi-pipe: grep | grep -v | head | cut ---")
    result = await ws.execute("grep queue-operation /supabase/example.jsonl"
                              " | grep -v error | head -n 2 | cut -d , -f 1")
    print(f"  Output:\n    {(await result.stdout_str()).strip()}")

    result_full = await ws.execute(
        "grep queue-operation /supabase/example.jsonl"
        " | grep -v error | cut -d , -f 1")
    full_lines = (await result_full.stdout_str()).strip().splitlines()
    print(f"  Without head: {len(full_lines)} lines (full Supabase download)")

    print("\n--- rg -l mirage /supabase ---")
    output = await (await ws.execute("rg -l mirage /supabase")).stdout_str()
    lines = output.strip().splitlines() if output.strip() else []
    print(f"  Files: {lines}")
    print(f"  Stats: {ops_summary()}")

    print("\n=== JQ QUERIES ===\n")

    print("--- jq .metadata ---")
    result = await ws.execute("jq .metadata /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all team names (nested [] iterator) ---")
    result = await ws.execute(
        "jq \".departments[].teams[].name\" /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all employee names ---")
    result = await ws.execute("jq \".departments[].teams[].members[].name\""
                              " /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: senior engineers on platform ---")
    result = await ws.execute("jq \".departments[0].teams[0].members"
                              " | map(select(.level == \\\"senior\\\"))"
                              " | map(.name)\" /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: all active project names ---")
    result = await ws.execute("jq \".departments[].teams[].projects"
                              " | map(select(.status == \\\"active\\\"))"
                              " | map(.name)\" /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: mirage project metrics ---")
    result = await ws.execute("jq .departments[0].teams[0].projects[0].metrics"
                              " /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: total budget ---")
    result = await ws.execute(
        "jq .metadata.total_budget /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: compact JSON row ---")
    result = await ws.execute("jq -c .metadata /supabase/example.json")
    print(f"  {(await result.stdout_str()).strip()}")

    print("\n--- jq: departments pretty json ---")
    result = await ws.execute("jq .departments /supabase/example.json")
    parsed = json.loads(await result.stdout_str())
    print(f"  departments: {len(parsed)}")
    print(f"  first team: {parsed[0]['teams'][0]['name']}")

    # chmod/chown/touch never hit the Storage API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /supabase/example.json ===")
    meta_res = await ws.execute(
        'chmod 640 "/supabase/example.json"'
        ' && chown 500:dev "/supabase/example.json"'
        ' && touch -t 202601021530 "/supabase/example.json"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/supabase/example.json"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")


if __name__ == "__main__":
    asyncio.run(main())
