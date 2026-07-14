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
import time

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.gcs import GCSConfig, GCSResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = GCSConfig(
    bucket=os.environ["GCS_BUCKET"],
    access_key_id=os.environ["GCS_ACCESS_KEY_ID"],
    secret_access_key=os.environ["GCS_SECRET_ACCESS_KEY"],
)

resource = GCSResource(config)
ws = Workspace({"/gcs/": resource}, mode=MountMode.READ)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


async def main():
    # ── discover structure ────────────────────────────
    print("=== ls /gcs/ ===")
    r = await ws.execute("ls /gcs/")
    print(await r.stdout_str())

    print("=== ls /gcs/data/ ===")
    r = await ws.execute("ls /gcs/data/")
    print(await r.stdout_str())

    # ── tree ──────────────────────────────────────────
    print("=== tree /gcs/ ===")
    r = await ws.execute("tree /gcs/")
    print(await r.stdout_str())

    # ── stat (directory prefix + file) ──────────────────
    print("=== stat /gcs/data (directory prefix) ===")
    r = await ws.execute("stat /gcs/data")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n=== stat /gcs/data/example.json ===")
    r = await ws.execute("stat /gcs/data/example.json")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── cat json ──────────────────────────────────────
    print("\n=== cat /gcs/data/example.json | head -n 10 ===")
    r = await ws.execute("cat /gcs/data/example.json | head -n 10")
    print(await r.stdout_str())

    # ── head / tail on jsonl ──────────────────────────
    print("=== head -n 3 /gcs/data/example.jsonl ===")
    r = await ws.execute("head -n 3 /gcs/data/example.jsonl")
    print((await r.stdout_str())[:300])

    print("\n=== tail -n 2 /gcs/data/example.jsonl ===")
    r = await ws.execute("tail -n 2 /gcs/data/example.jsonl")
    print((await r.stdout_str())[:300])

    # ── wc ────────────────────────────────────────────
    print("\n=== wc -l /gcs/data/example.jsonl ===")
    r = await ws.execute("wc -l /gcs/data/example.jsonl")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── grep ──────────────────────────────────────────
    print("\n=== grep -c mirage /gcs/data/example.jsonl ===")
    r = await ws.execute("grep -c mirage /gcs/data/example.jsonl")
    print(f"  count: {(await r.stdout_str()).strip()}")

    print("\n=== grep mirage /gcs/data/example.jsonl | head -n 3 ===")
    r = await ws.execute("grep mirage /gcs/data/example.jsonl | head -n 3")
    lines = (await r.stdout_str()).strip().splitlines()
    for ln in lines:
        print(f"  {ln[:100]}...")

    # ── find ──────────────────────────────────────────
    print("\n=== find /gcs/ -name '*.json' ===")
    r = await ws.execute("find /gcs/ -name '*.json'")
    print(await r.stdout_str())

    print("=== find /gcs/ -name '*.parquet' ===")
    r = await ws.execute("find /gcs/ -name '*.parquet'")
    print(await r.stdout_str())

    # ── jq ────────────────────────────────────────────
    print("=== jq .metadata /gcs/data/example.json ===")
    r = await ws.execute("jq .metadata /gcs/data/example.json")
    print(f"  {(await r.stdout_str()).strip()[:200]}")

    print("\n=== jq '.departments[].teams[].name'"
          " /gcs/data/example.json ===")
    r = await ws.execute(
        'jq ".departments[].teams[].name" /gcs/data/example.json')
    print(f"  {(await r.stdout_str()).strip()}")

    # ── pipelines ─────────────────────────────────────
    print("\n=== cat example.jsonl | grep queue-operation"
          " | sort | uniq | wc -l ===")
    r = await ws.execute("cat /gcs/data/example.jsonl"
                         " | grep queue-operation | sort | uniq | wc -l")
    print(f"  unique lines: {(await r.stdout_str()).strip()}")

    # ── cd + relative paths ───────────────────────────
    print("\n=== pwd ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print('\n=== cd /gcs/data ===')
    r = await ws.execute("cd /gcs/data")
    print(f"  exit={r.exit_code}")

    print("\n=== pwd (after cd) ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n=== ls (relative) ===")
    r = await ws.execute("ls")
    print(await r.stdout_str())

    print("=== head -n 3 example.json (relative) ===")
    r = await ws.execute("head -n 3 example.json")
    print(await r.stdout_str())

    # ── streaming & barrier scenarios ─────────────────
    print("\n=== cat | grep | head (streaming drain) ===")
    r = await ws.execute("cat /gcs/data/example.jsonl | grep queue | head -n 3"
                         )
    lines = (await r.stdout_str()).strip().splitlines()
    print(f"  got {len(lines)} lines (expected 3)")

    print("\n=== grep -q && echo (barrier VALUE) ===")
    r = await ws.execute(
        'grep -q queue /gcs/data/example.jsonl && echo "found"')
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    print("\n=== grep -q || echo (barrier OR) ===")
    r = await ws.execute('grep -q NONEXISTENT_STRING /gcs/data/example.jsonl'
                         ' || echo "not found"')
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    print("\n=== grep ; grep (semicolon materialization) ===")
    r = await ws.execute("grep -c queue /gcs/data/example.jsonl"
                         "; grep -c mirage /gcs/data/example.jsonl")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== grep missing ; echo $? (semicolon exit code) ===")
    r = await ws.execute("grep NONEXISTENT_STRING /gcs/data/example.jsonl"
                         "; echo $?")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== cat nonexistent 2>&1 | head (stderr in pipe) ===")
    r = await ws.execute("cat /gcs/data/nonexistent_file 2>&1 | head -n 1")
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    # ── Step 16: 2>&1 fixes — no double-emit, stream stdout ──
    # Without 2>&1: error stays in stderr, stdout empty.
    print("\n=== cat nonexistent | cat (no merge: error in stderr) ===")
    r = await ws.execute("cat /gcs/data/nonexistent_file | cat")
    print(f"  stdout: '{(await r.stdout_str()).strip()}' (expect empty)")
    print(f"  stderr: '{(await r.stderr_str()).strip()[:80]}'")

    # With 2>&1: error goes into pipe → reaches final stdout.
    # Crucially, final stderr should be empty (no double-emit).
    print("\n=== cat nonexistent 2>&1 | cat (no double-emit) ===")
    r = await ws.execute("cat /gcs/data/nonexistent_file 2>&1 | cat")
    out = (await r.stdout_str()).strip()
    err = (await r.stderr_str()).strip()
    print(f"  stdout: '{out[:80]}'")
    print(f"  stderr: '{err}' (expect empty: no double-emit)")

    # 2>&1 streams stdout chunk-by-chunk through merge.
    # Real GCS payload (5766 lines) piped through 2>&1 to wc -l
    # should match wc -l on the file directly.
    print("\n=== cat large 2>&1 | wc -l (streams real payload) ===")
    r = await ws.execute("wc -l /gcs/data/example.jsonl")
    expected = int((await r.stdout_str()).strip().split()[0])
    r = await ws.execute("cat /gcs/data/example.jsonl 2>&1 | wc -l")
    got = int((await r.stdout_str()).strip())
    print(f"  expected: {expected}  got: {got}  "
          f"{'OK' if got == expected else 'MISMATCH'}")

    print("\n=== cat | sort | uniq | wc -l (full pipeline) ===")
    r = await ws.execute("cat /gcs/data/example.jsonl"
                         " | sort | uniq | wc -l")
    print(f"  unique lines: {(await r.stdout_str()).strip()}")

    # ── background job scenarios ────────────────────
    print("\n=== grep -c & echo kicked off; wait (bg job) ===")
    r = await ws.execute("grep -c queue /gcs/data/example.jsonl &"
                         " echo 'kicked off'; wait")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== sleep 0 & cat (bg doesn't consume stdin) ===")
    r = await ws.execute("sleep 0 & cat /gcs/data/example.json | head -n 1")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== cat nonexistent & echo ok (bg error handled) ===")
    r = await ws.execute(
        "cat /gcs/data/nonexistent_file & echo ok; wait; echo done")
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    print("\n=== multiple bg: grep & wc & wait (parallel) ===")
    r = await ws.execute("grep -c queue /gcs/data/example.jsonl &"
                         " wc -l /gcs/data/example.jsonl &"
                         " wait; echo all done")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    # ── lazy stdin in loops (Step 15) ────────────────
    # Functional checks. True laziness is measured by the unit test
    # (test_while_read_break_stops_pulling) — it counts producer pulls.
    # End-to-end over the network these are just correctness checks.

    # Bounded loop (head limits upstream → exact iter count).
    # With lazy stdin, `head -n 5` triggers EOF after 5 lines, the
    # while loop sees readline()==None, exits cleanly.
    print("\n=== head -n 5 | while read; do echo (bounded loop) ===")
    r = await ws.execute("cat /gcs/data/example.jsonl | head -n 5"
                         " | while read LINE; do echo got; done | wc -l")
    print(f"  iterations: {(await r.stdout_str()).strip()} (expected 5)")

    # Early break: only one iter, rest of upstream untouched.
    # Visible via unit test `test_while_read_break_stops_pulling`;
    # here we only check stdout shape.
    print("\n=== while read; break (early exit) ===")
    r = await ws.execute("cat /gcs/data/example.jsonl | head -n 100"
                         " | while read LINE; do echo first; break; done")
    out = (await r.stdout_str()).strip().splitlines()
    print(f"  stdout lines: {len(out)} (expected 1)  exit={r.exit_code}")

    # for-loop over fixed value list, with stdin available to body.
    # Each iter calls `read` once → consumes one line from buffer.
    print("\n=== for x in a b c; do read LINE (loop reads buffer) ===")
    r = await ws.execute(
        "cat /gcs/data/example.jsonl | head -n 3"
        " | for x in a b c; do read LINE; echo \"$x:${LINE:0:30}\"; done")
    for line in (await r.stdout_str()).strip().splitlines():
        print(f"  {line}")

    # Note: while-loop over an unbounded stream is currently capped
    # at _MAX_WHILE=10000 iterations regardless of input size. This is
    # a separate safety limit, not a laziness issue.
    print("\n  (note: while over unbounded stream caps at 10000 iters)")

    # ── quoting / escaping patterns commonly used by AI agents ──
    # These exercise the bash double-quote escape rules + variable
    # expansion semantics the agent relies on.

    print("\n=== echo \"\\$X\" (escaped dollar stays literal) ===")
    await ws.execute("export X=expanded")
    r = await ws.execute('echo "\\$X"')
    print(f"  stdout: {json.dumps((await r.stdout_str()).strip())}"
          " (expect '$X')")

    print("\n=== echo \"$X\" (unescaped dollar expands) ===")
    r = await ws.execute('echo "$X"')
    print(f"  stdout: {json.dumps((await r.stdout_str()).strip())}"
          " (expect 'expanded')")

    print("\n=== echo '$X' (single quotes keep $X literal) ===")
    r = await ws.execute("echo '$X'")
    print(f"  stdout: {json.dumps((await r.stdout_str()).strip())}"
          " (expect '$X')")

    print("\n=== cat \"$DIR/example.json\" (env var in path) ===")
    await ws.execute("export DIR=/gcs/data")
    r = await ws.execute('cat "$DIR/example.json" | head -n 3')
    out = (await r.stdout_str()).strip().splitlines()
    print(f"  first lines: {json.dumps(out, separators=(',', ':'))}")

    print("\n=== cat $(echo /gcs/data/example.json) | head -n 1"
          " (command sub as path) ===")
    r = await ws.execute("cat $(echo /gcs/data/example.json) | head -n 1")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== grep \"$(echo queue)\" /gcs/data/example.jsonl"
          " | wc -l (sub as pattern) ===")
    r = await ws.execute('grep "$(echo queue)" /gcs/data/example.jsonl | wc -l'
                         )
    print(f"  count: {(await r.stdout_str()).strip()}")

    # ── on-the-fly max_drain_bytes (cancellable cache drain) ──────────
    # Demonstrates: set a small budget → cat | head leaves the source
    # only partially read → background drain trips the budget → cache
    # is NOT populated. Then unset the budget → drain completes → cache
    # IS populated. Drain tasks are awaited explicitly (vs sleeping)
    # so we don't race the network.
    target = "/gcs/data/example.jsonl"
    await ws.cache.clear()
    print("\n=== max_drain_bytes=1MB then cat | head (drain cancelled) ===")
    ws.max_drain_bytes = 1_000_000
    r = await ws.execute(f"cat {target} | head -n 3")
    print(f"  head returned {len((await r.stdout_str()).splitlines())} lines")
    drain_keys = list(ws.cache._drain_tasks.keys())
    print(f"  drain tasks: {json.dumps(drain_keys, separators=(',', ':'))}")
    for k in drain_keys:
        await ws.cache._drain_tasks[k]
    cached = None
    for k in drain_keys:
        cached = await ws.cache.get(k) or cached
    if cached:
        status = f"POPULATED ({len(cached)} bytes)"
    else:
        status = "EMPTY (drain cancelled, as expected)"
    print(f"  cache after small budget: {status}")

    await ws.cache.clear()
    print("\n=== max_drain_bytes=None then cat | head (drain completes) ===")
    ws.max_drain_bytes = None
    r = await ws.execute(f"cat {target} | head -n 3")
    print(f"  head returned {len((await r.stdout_str()).splitlines())} lines")
    drain_keys = list(ws.cache._drain_tasks.keys())
    print(f"  drain tasks: {json.dumps(drain_keys, separators=(',', ':'))}")
    for k in drain_keys:
        await ws.cache._drain_tasks[k]
    cached = None
    for k in drain_keys:
        cached = await ws.cache.get(k) or cached
    if cached:
        status = f"POPULATED ({len(cached)} bytes, as expected)"
    else:
        status = "EMPTY"
    print(f"  cache after unbounded: {status}")

    # ── chunk-level streaming + multi-stage pipe backpressure ─────────
    print("\n=== STREAMING (single command) ===")
    target = "/gcs/data/example.jsonl"
    r = await ws.execute(f"stat -c '%s' {target}")
    size = int((await r.stdout_str()).strip())
    print(f"  object size: {size:,} bytes")

    async def measure(label: str, cmd: str) -> None:
        before = sum(rec.bytes for rec in ws.ops.records)
        t0 = time.monotonic()
        r = await ws.execute(cmd)
        dt = time.monotonic() - t0
        net = sum(rec.bytes for rec in ws.ops.records) - before
        head = (await r.stdout_str()).strip().splitlines()
        first = head[0][:48] if head else ""
        print(f"  {label:42s} bytes={net:>10,}  t={dt:4.2f}s  "
              f"lines={len(head):>4}  out0={json.dumps(first)}")

    await ws.cache.clear()
    await measure("head -n 1 (line-streamed)", f"head -n 1 {target}")
    await ws.cache.clear()
    await measure("head -c 100 (byte-range)", f"head -c 100 {target}")
    await ws.cache.clear()
    await measure("grep -m 1 (early-exit)", f"grep -m 1 mirage {target}")

    print("\n=== STREAMING CHAIN (multi-stage pipe backpressure) ===")
    await ws.cache.clear()
    await measure("cat | head -n 1", f"cat {target} | head -n 1")
    await ws.cache.clear()
    await measure("cat | tr A-Z a-z | head -n 1",
                  f"cat {target} | tr A-Z a-z | head -n 1")
    await ws.cache.clear()
    await measure("cat | grep mirage | head -n 1",
                  f"cat {target} | grep mirage | head -n 1")
    await ws.cache.clear()
    await measure("4-stage: cat|tr|grep|head -n 1",
                  f"cat {target} | tr A-Z a-z | grep mirage | head -n 1")
    await ws.cache.clear()
    await measure(
        "5-stage: cat|tr|grep|head|wc -l",
        f"cat {target} | tr A-Z a-z | grep mirage | head -n 1 "
        "| wc -l")
    await ws.cache.clear()
    await measure("non-cancellable: cat | wc -l", f"cat {target} | wc -l")

    print(f"\nStats: {ops_summary()}")

    # chmod/chown/touch never hit the GCS API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /gcs/data/example.jsonl ===")
    meta_res = await ws.execute(
        'chmod 640 "/gcs/data/example.jsonl"'
        ' && chown 500:dev "/gcs/data/example.jsonl"'
        ' && touch -t 202601021530 "/gcs/data/example.jsonl"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch(
        "stat", PathSpec.from_str_path("/gcs/data/example.jsonl"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")


if __name__ == "__main__":
    asyncio.run(main())
