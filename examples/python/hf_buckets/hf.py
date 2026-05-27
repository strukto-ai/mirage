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
import os
import time
import uuid

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.hf_buckets import HfBucketsConfig, HfBucketsResource

load_dotenv(".env.development")

config = HfBucketsConfig(
    bucket=os.environ["HF_BUCKET_NAME"],
    token=os.environ["HF_TOKEN"],
)

resource = HfBucketsResource(config)
ws = Workspace({"/hf/": resource}, mode=MountMode.WRITE)


def ops_summary() -> str:
    records = ws.ops.records
    total = sum(r.bytes for r in records)
    return f"{len(records)} ops, {total} bytes transferred"


def show_plan(label: str, dr) -> None:
    print(f"\n--- plan: {label} ---")
    print(f"  network_read: {dr.network_read}  cache_read: {dr.cache_read}")
    print(f"  read_ops: {dr.read_ops}  cache_hits: {dr.cache_hits}  "
          f"precision: {dr.precision}")


async def main():
    # ── discover structure ────────────────────────────
    print("=== ls /hf/ ===")
    r = await ws.execute("ls /hf/")
    print(await r.stdout_str())

    # ── tree ──────────────────────────────────────────
    print("=== tree /hf/ ===")
    r = await ws.execute("tree /hf/")
    print(await r.stdout_str())

    # ── stat (root + file) ──────────────────────────────
    print("=== stat /hf (root) ===")
    r = await ws.execute("stat /hf")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n=== stat /hf/example.json ===")
    r = await ws.execute("stat /hf/example.json")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── cat json ──────────────────────────────────────
    print("\n=== cat /hf/example.json | head -n 10 ===")
    r = await ws.execute("cat /hf/example.json | head -n 10")
    print(await r.stdout_str())

    # ── head / tail on jsonl ──────────────────────────
    print("=== head -n 3 /hf/example.jsonl ===")
    r = await ws.execute("head -n 3 /hf/example.jsonl")
    print((await r.stdout_str())[:300])

    print("\n=== tail -n 2 /hf/example.jsonl ===")
    r = await ws.execute("tail -n 2 /hf/example.jsonl")
    print((await r.stdout_str())[:300])

    # ── wc ────────────────────────────────────────────
    print("\n=== wc -l /hf/example.jsonl ===")
    r = await ws.execute("wc -l /hf/example.jsonl")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── grep ──────────────────────────────────────────
    print("\n=== grep -c mirage /hf/example.jsonl ===")
    r = await ws.execute("grep -c mirage /hf/example.jsonl")
    print(f"  count: {(await r.stdout_str()).strip()}")

    print("\n=== grep mirage /hf/example.jsonl | head -n 3 ===")
    r = await ws.execute("grep mirage /hf/example.jsonl | head -n 3")
    lines = (await r.stdout_str()).strip().splitlines()
    for ln in lines:
        print(f"  {ln[:100]}...")

    # ── find ──────────────────────────────────────────
    print("\n=== find /hf/ -name '*.json' ===")
    r = await ws.execute("find /hf/ -name '*.json'")
    print(await r.stdout_str())

    print("=== find /hf/ -name '*.parquet' ===")
    r = await ws.execute("find /hf/ -name '*.parquet'")
    print(await r.stdout_str())

    # ── jq ────────────────────────────────────────────
    print("=== jq .metadata /hf/example.json ===")
    r = await ws.execute("jq .metadata /hf/example.json")
    print(f"  {(await r.stdout_str()).strip()[:200]}")

    print("\n=== jq -r '.departments[].teams[].name'"
          " /hf/example.json ===")
    r = await ws.execute('jq ".departments[].teams[].name" /hf/example.json')
    print(f"  {(await r.stdout_str()).strip()}")

    # ── pipelines ─────────────────────────────────────
    print("\n=== cat example.jsonl | grep queue-operation"
          " | sort | uniq | wc -l ===")
    r = await ws.execute("cat /hf/example.jsonl"
                         " | grep queue-operation | sort | uniq | wc -l")
    print(f"  unique lines: {(await r.stdout_str()).strip()}")

    # ── cd + relative paths ───────────────────────────
    print("\n=== pwd ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print('\n=== cd /hf ===')
    r = await ws.execute("cd /hf")
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
    r = await ws.execute("cat /hf/example.jsonl | grep queue | head -n 3")
    lines = (await r.stdout_str()).strip().splitlines()
    print(f"  got {len(lines)} lines (expected 3)")

    print("\n=== grep -q && echo (barrier VALUE) ===")
    r = await ws.execute('grep -q queue /hf/example.jsonl && echo "found"')
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    print("\n=== grep -q || echo (barrier OR) ===")
    r = await ws.execute('grep -q NONEXISTENT_STRING /hf/example.jsonl'
                         ' || echo "not found"')
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    print("\n=== grep ; grep (semicolon materialization) ===")
    r = await ws.execute("grep -c queue /hf/example.jsonl"
                         "; grep -c mirage /hf/example.jsonl")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== grep missing ; echo $? (semicolon exit code) ===")
    r = await ws.execute("grep NONEXISTENT_STRING /hf/example.jsonl"
                         "; echo $?")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== cat nonexistent 2>&1 | head (stderr in pipe) ===")
    r = await ws.execute("cat /hf/nonexistent_file 2>&1 | head -n 1")
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    print("\n=== cat nonexistent | cat (no merge: error in stderr) ===")
    r = await ws.execute("cat /hf/nonexistent_file | cat")
    print(f"  stdout: '{(await r.stdout_str()).strip()}' (expect empty)")
    print(f"  stderr: '{(await r.stderr_str()).strip()[:80]}'")

    print("\n=== cat nonexistent 2>&1 | cat (no double-emit) ===")
    r = await ws.execute("cat /hf/nonexistent_file 2>&1 | cat")
    out = (await r.stdout_str()).strip()
    err = (await r.stderr_str()).strip()
    print(f"  stdout: '{out[:80]}'")
    print(f"  stderr: '{err}' (expect empty: no double-emit)")

    print("\n=== cat large 2>&1 | wc -l (streams real payload) ===")
    r = await ws.execute("wc -l /hf/example.jsonl")
    expected = int((await r.stdout_str()).strip().split()[0])
    r = await ws.execute("cat /hf/example.jsonl 2>&1 | wc -l")
    got = int((await r.stdout_str()).strip())
    print(f"  expected: {expected}  got: {got}  "
          f"{'OK' if got == expected else 'MISMATCH'}")

    print("\n=== cat | sort | uniq | wc -l (full pipeline) ===")
    r = await ws.execute("cat /hf/example.jsonl | sort | uniq | wc -l")
    print(f"  unique lines: {(await r.stdout_str()).strip()}")

    # ── background job scenarios ────────────────────
    print("\n=== grep -c & echo kicked off; wait (bg job) ===")
    r = await ws.execute("grep -c queue /hf/example.jsonl &"
                         " echo 'kicked off'; wait")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== sleep 0 & cat (bg doesn't consume stdin) ===")
    r = await ws.execute("sleep 0 & cat /hf/example.json | head -n 1")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== cat nonexistent & echo ok (bg error handled) ===")
    r = await ws.execute("cat /hf/nonexistent_file & echo ok; wait; echo done")
    print(f"  stdout: {(await r.stdout_str()).strip()}")
    print(f"  exit: {r.exit_code}")

    print("\n=== multiple bg: grep & wc & wait (parallel) ===")
    r = await ws.execute("grep -c queue /hf/example.jsonl &"
                         " wc -l /hf/example.jsonl &"
                         " wait; echo all done")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    # ── lazy stdin in loops ───────────────────────────
    print("\n=== head -n 5 | while read; do echo (bounded loop) ===")
    r = await ws.execute("cat /hf/example.jsonl | head -n 5"
                         " | while read LINE; do echo got; done | wc -l")
    print(f"  iterations: {(await r.stdout_str()).strip()} (expected 5)")

    print("\n=== while read; break (early exit) ===")
    r = await ws.execute("cat /hf/example.jsonl | head -n 100"
                         " | while read LINE; do echo first; break; done")
    out = (await r.stdout_str()).strip().splitlines()
    print(f"  stdout lines: {len(out)} (expected 1)  exit={r.exit_code}")

    print("\n=== for x in a b c; do read LINE (loop reads buffer) ===")
    r = await ws.execute(
        "cat /hf/example.jsonl | head -n 3"
        " | for x in a b c; do read LINE; echo \"$x:${LINE:0:30}\"; done")
    for line in (await r.stdout_str()).strip().splitlines():
        print(f"  {line}")

    # ── quoting / escaping ────────────────────────────
    print("\n=== echo \"\\$X\" (escaped dollar stays literal) ===")
    await ws.execute("export X=expanded")
    r = await ws.execute('echo "\\$X"')
    print(f"  stdout: {(await r.stdout_str()).strip()!r} (expect '$X')")

    print("\n=== echo \"$X\" (unescaped dollar expands) ===")
    r = await ws.execute('echo "$X"')
    print(f"  stdout: {(await r.stdout_str()).strip()!r} (expect 'expanded')")

    print("\n=== echo '$X' (single quotes keep $X literal) ===")
    r = await ws.execute("echo '$X'")
    print(f"  stdout: {(await r.stdout_str()).strip()!r} (expect '$X')")

    print("\n=== cat \"$DIR/example.json\" (env var in path) ===")
    await ws.execute("export DIR=/hf")
    r = await ws.execute('cat "$DIR/example.json" | head -n 3')
    out = (await r.stdout_str()).strip().splitlines()
    print(f"  first lines: {out}")

    print("\n=== cat $(echo /hf/example.json) | head -n 1"
          " (command sub as path) ===")
    r = await ws.execute("cat $(echo /hf/example.json) | head -n 1")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    print("\n=== grep \"$(echo queue)\" /hf/example.jsonl"
          " | wc -l (sub as pattern) ===")
    r = await ws.execute('grep "$(echo queue)" /hf/example.jsonl | wc -l')
    print(f"  count: {(await r.stdout_str()).strip()}")

    # ── PROVISION: estimate cost without executing ────────────────────
    # Returns a ProvisionResult with network_read / cache_read / precision
    # instead of running the command. Provisioned commands:
    #   file_read_provision: cat, wc        (full-file read, EXACT)
    #   head_tail_provision: head, tail     (EXACT for -c, RANGE for -n)
    #   metadata_provision : find, ls, stat (0 bytes, EXACT)
    #   grep / jq          : inline provisioners in their command files
    # When a file is already in the workspace cache, the workspace
    # automatically moves network_read into cache_read and zeros
    # network_read. That's why we clear the cache first to see the
    # "first-time" estimate, then re-plan after caching to see the diff.
    print("\n=== PROVISION (plan without executing) ===")
    await ws.cache.clear()
    before_plan = ops_summary()

    # ── single-command plans (cache cleared, so network_read shows up) ──
    dr = await ws.execute("cat /hf/example.json", provision=True)
    show_plan("cat /hf/example.json (file_read_provision)", dr)

    dr = await ws.execute("wc -l /hf/example.jsonl", provision=True)
    show_plan("wc -l /hf/example.jsonl (file_read_provision)", dr)

    dr = await ws.execute("head -c 100 /hf/example.jsonl", provision=True)
    show_plan("head -c 100 /hf/example.jsonl (byte budget, EXACT)", dr)

    dr = await ws.execute("head -n 5 /hf/example.jsonl", provision=True)
    show_plan("head -n 5 /hf/example.jsonl (line budget, RANGE)", dr)
    print(f"  range: [{dr.network_read_low}, {dr.network_read_high}]")

    dr = await ws.execute("ls /hf/", provision=True)
    show_plan("ls /hf/ (metadata_provision, 0 bytes)", dr)

    dr = await ws.execute("stat /hf/example.json", provision=True)
    show_plan("stat /hf/example.json (metadata_provision)", dr)

    dr = await ws.execute("grep mirage /hf/example.jsonl", provision=True)
    show_plan("grep mirage /hf/example.jsonl (grep_provision)", dr)

    dr = await ws.execute("jq .metadata /hf/example.json", provision=True)
    show_plan("jq .metadata /hf/example.json (jq_provision)", dr)

    # ── compound plans ──
    dr = await ws.execute("cat /hf/example.jsonl | head -n 3", provision=True)
    print("\n--- plan: cat | head -n 3 (pipeline with children) ---")
    print(f"  op: {dr.op}  children: {len(dr.children)}  "
          f"precision: {dr.precision}")
    print(f"  network_read: {dr.network_read}  cache_read: {dr.cache_read}")
    for c in dr.children:
        print(f"    {c.command}: net={c.network_read}  "
              f"cache={c.cache_read}  {c.precision}")

    dr = await ws.execute("grep mirage /hf/example.jsonl && echo found",
                          provision=True)
    print("\n--- plan: grep ... && echo found (compound) ---")
    print(f"  op: {dr.op}  network_read: {dr.network_read}")
    for c in dr.children:
        print(f"    {c.command}: net={c.network_read}  {c.precision}")

    print(f"\n  Stats before plans: {before_plan}")
    print(f"  Stats after plans:  {ops_summary()}  (planning is read-free)")

    # ── cache-aware plan: same command after caching the file ──
    print("\n--- caching: cat /hf/example.json | wc -c ---")
    r = await ws.execute("cat /hf/example.json | wc -c")
    print(f"  bytes: {(await r.stdout_str()).strip()}")

    dr = await ws.execute("cat /hf/example.json", provision=True)
    print("\n--- plan after cache: cat /hf/example.json ---")
    print(f"  network_read: {dr.network_read}  "
          f"cache_read: {dr.cache_read}  cache_hits: {dr.cache_hits}")
    print("  (network shifted to cache: file is hot)")

    # ── chunk-level streaming + multi-stage pipe backpressure ─────────
    print("\n=== STREAMING (single command) ===")
    target = "/hf/example.jsonl"
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
              f"lines={len(head):>4}  out0={first!r}")

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

    # WRITE + REMOVE flow. HF Buckets silently drops zero-byte uploads,
    # so we use ws.ops.write to push non-empty bytes (touch would no-op).
    # Demonstrates parent-dir index cache invalidation: without it, `ls`
    # after a write would return stale entries.
    test_file = f"/hf/test-{uuid.uuid4().hex[:8]}.txt"
    test_file.rsplit("/", 1)[-1]
    print(f"\n=== WRITE + REMOVE FLOW (using {test_file}) ===")

    print(f"\n--- write '{test_file}' (14 bytes) ---")
    await ws.ops.write(test_file, b"Hello, Mirage!")
    print("  written")

    print(f"\n--- stat {test_file} (should succeed) ---")
    r = await ws.execute(f"stat {test_file}")
    print(f"  {(await r.stdout_str()).strip()}")

    print(f"\n--- cat {test_file} ---")
    r = await ws.execute(f"cat {test_file}")
    print(f"  {(await r.stdout_str()).strip()!r}")

    print(f"\n--- rm {test_file} ---")
    r = await ws.execute(f"rm {test_file}")
    print(f"  exit: {r.exit_code}")

    print(f"\n--- stat {test_file} (should fail: not found) ---")
    r = await ws.execute(f"stat {test_file}")
    err = (await r.stderr_str()).strip()[:80]
    print(f"  exit: {r.exit_code}  stderr: {err}")

    # touch on an existing file is still tested (no-op when c=False but
    # file exists, since exists() short-circuits).
    print("\n--- touch on existing file (no-op) ---")
    r = await ws.execute("touch /hf/example.json")
    print(f"  exit: {r.exit_code}")

    print(f"\nStats: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
