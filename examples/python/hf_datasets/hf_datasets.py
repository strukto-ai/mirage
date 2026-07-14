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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.hf_datasets import HfDatasetsConfig, HfDatasetsResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = HfDatasetsConfig(
    repo_id=os.environ.get("HF_DATASET_REPO",
                           "AlienKevin/SWE-ZERO-12M-trajectories"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfDatasetsResource(config)
ws = Workspace({"/ds/": resource}, mode=MountMode.READ)


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
    print(f"=== mounted {resource.accessor.bucket_uri} at /ds/ ===")

    print("\n=== not-found errors show the full virtual path ===")
    for cmd in ("cat /ds/__nf_missing__.txt", "head /ds/__nf_missing__.txt",
                "stat /ds/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ── discover structure ──────────────────────────────
    print("\n=== ls /ds/ ===")
    r = await ws.execute("ls /ds/")
    print(await r.stdout_str())

    print("=== ls -lh /ds/ ===")
    r = await ws.execute("ls -lh /ds/")
    print(await r.stdout_str())

    print("=== tree -L 2 /ds/ ===")
    r = await ws.execute("tree -L 2 /ds/")
    print((await r.stdout_str())[:400])

    # ── stat ────────────────────────────────────────────
    print("\n=== stat /ds (root) ===")
    r = await ws.execute("stat /ds")
    print(f"  {(await r.stdout_str()).strip()}")

    print("\n=== stat /ds/README.md ===")
    r = await ws.execute("stat /ds/README.md")
    print(f"  {(await r.stdout_str()).strip()}")

    # chmod/chown/touch never hit the Hub API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /ds/README.md ===")
    meta_res = await ws.execute('chmod 640 "/ds/README.md"'
                                ' && chown 500:dev "/ds/README.md"'
                                ' && touch -t 202601021530 "/ds/README.md"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path("/ds/README.md"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    # ── find ────────────────────────────────────────────
    print("\n=== find /ds/ -name '*.md' ===")
    r = await ws.execute("find /ds/ -name '*.md'")
    print(await r.stdout_str())

    print("=== find /ds/ -type d ===")
    r = await ws.execute("find /ds/ -type d")
    print(await r.stdout_str())

    print("=== find /ds/ -name '*.parquet' | head -n 5 ===")
    r = await ws.execute("find /ds/ -name '*.parquet' | head -n 5")
    print(await r.stdout_str())

    print("=== find /ds/ -name '*.parquet' | wc -l ===")
    r = await ws.execute("find /ds/ -name '*.parquet' | wc -l")
    print(f"  parquet shard count: {(await r.stdout_str()).strip()}")

    # ── cat / head / tail / wc ──────────────────────────
    print("\n=== cat /ds/README.md | head -n 20 ===")
    r = await ws.execute("cat /ds/README.md | head -n 20")
    print(await r.stdout_str())

    print("=== wc -l /ds/README.md ===")
    r = await ws.execute("wc -l /ds/README.md")
    print(f"  {(await r.stdout_str()).strip()}")

    print("=== head -c 200 /ds/README.md (byte range) ===")
    r = await ws.execute("head -c 200 /ds/README.md")
    print(await r.stdout_str())

    # ── grep ────────────────────────────────────────────
    print("\n=== grep -c parquet /ds/README.md ===")
    r = await ws.execute("grep -c parquet /ds/README.md")
    print(f"  count: {(await r.stdout_str()).strip()}")

    print("=== grep -i license /ds/README.md ===")
    r = await ws.execute("grep -i license /ds/README.md")
    print(f"  {(await r.stdout_str()).strip()}")

    # ── pipelines ───────────────────────────────────────
    print("\n=== find /ds/ -name '*.parquet' | sort | head -n 3 ===")
    r = await ws.execute("find /ds/ -name '*.parquet' | sort | head -n 3")
    print(await r.stdout_str())

    print("=== cat /ds/README.md | grep -i tag | head -n 5 ===")
    r = await ws.execute("cat /ds/README.md | grep -i tag | head -n 5")
    print(await r.stdout_str())

    # ── cd + relative paths ─────────────────────────────
    print("=== pwd ===")
    r = await ws.execute("pwd")
    print(f"  {(await r.stdout_str()).strip()}")

    print("=== cd /ds; pwd; ls | head ===")
    r = await ws.execute("cd /ds")
    r = await ws.execute("pwd")
    print(f"  pwd: {(await r.stdout_str()).strip()}")
    r = await ws.execute("ls | head -n 5")
    print(f"  ls (relative):\n{(await r.stdout_str()).rstrip()}")

    # ── barriers + semicolons ───────────────────────────
    print("\n=== grep -q parquet /ds/README.md && echo 'found' ===")
    r = await ws.execute("grep -q parquet /ds/README.md && echo 'found'")
    print(f"  stdout: {(await r.stdout_str()).strip()}  exit: {r.exit_code}")

    print("=== grep -q nope /ds/README.md || echo 'absent' ===")
    r = await ws.execute("grep -q nope /ds/README.md || echo 'absent'")
    print(f"  stdout: {(await r.stdout_str()).strip()}  exit: {r.exit_code}")

    print("=== grep -c parquet README ; wc -l README (semicolon) ===")
    r = await ws.execute("grep -c parquet /ds/README.md"
                         "; wc -l /ds/README.md")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    # ── quoting / escaping / command substitution ───────
    print("\n=== quoting / $(...) / env vars ===")
    await ws.execute("export TGT=/ds/README.md")
    r = await ws.execute('cat "$TGT" | head -n 2')
    print(f'  cat "$TGT" | head -n 2:\n{(await r.stdout_str()).rstrip()}')

    r = await ws.execute("head -n 1 $(echo /ds/README.md)")
    print(f"  head -n 1 $(echo /ds/README.md): "
          f"{(await r.stdout_str()).strip()}")

    # ── background jobs ─────────────────────────────────
    print("\n=== background jobs ===")
    r = await ws.execute("grep -c parquet /ds/README.md &"
                         " echo 'kicked off'; wait")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    r = await ws.execute("grep -c parquet /ds/README.md &"
                         " wc -l /ds/README.md &"
                         " wait; echo all done")
    print(f"  parallel: {(await r.stdout_str()).strip()}")

    # ── PROVISION (dry-run cost plans) ──────────────────
    print("\n=== PROVISION (plan without executing) ===")
    await ws.cache.clear()
    before = ops_summary()

    dr = await ws.execute("cat /ds/README.md", provision=True)
    show_plan("cat /ds/README.md", dr)

    dr = await ws.execute("head -c 100 /ds/README.md", provision=True)
    show_plan("head -c 100 /ds/README.md (byte budget, EXACT)", dr)

    dr = await ws.execute("head -n 5 /ds/README.md", provision=True)
    show_plan("head -n 5 /ds/README.md (line budget, RANGE)", dr)
    print(f"  range: [{dr.network_read_low}, {dr.network_read_high}]")

    dr = await ws.execute("ls /ds/", provision=True)
    show_plan("ls /ds/ (metadata only, 0 bytes)", dr)

    dr = await ws.execute("find /ds/ -name '*.parquet'", provision=True)
    show_plan("find /ds/ -name '*.parquet' (metadata only)", dr)

    print(f"\n  before plans: {before}")
    print(f"  after plans:  {ops_summary()}  (planning is read-free)")

    # ── streaming chain backpressure ────────────────────
    print("\n=== STREAMING (chain backpressure) ===")
    target = "/ds/README.md"
    r = await ws.execute(f"stat -c '%s' {target}")
    print(f"  size: {(await r.stdout_str()).strip()} bytes")

    async def measure(label: str, cmd: str) -> None:
        before_bytes = sum(rec.bytes for rec in ws.ops.records)
        t0 = time.monotonic()
        r = await ws.execute(cmd)
        dt = time.monotonic() - t0
        net = sum(rec.bytes for rec in ws.ops.records) - before_bytes
        out = (await r.stdout_str()).rstrip().splitlines()
        print(f"  {label:38s} bytes={net:>6,}  t={dt:4.2f}s  "
              f"lines={len(out):>3}")

    await ws.cache.clear()
    await measure("head -n 1 (line streamed)", f"head -n 1 {target}")
    await ws.cache.clear()
    await measure("head -c 100 (byte range)", f"head -c 100 {target}")
    await ws.cache.clear()
    await measure("grep -m 1 (early exit)", f"grep -m 1 parquet {target}")
    await ws.cache.clear()
    await measure("cat | head -n 1", f"cat {target} | head -n 1")
    await ws.cache.clear()
    await measure("cat | tr A-Z a-z | head -n 1",
                  f"cat {target} | tr A-Z a-z | head -n 1")
    await ws.cache.clear()
    await measure("4-stage: cat|tr|grep|head -n 1",
                  f"cat {target} | tr A-Z a-z | grep parquet | head -n 1")

    print(f"\nFinal: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
