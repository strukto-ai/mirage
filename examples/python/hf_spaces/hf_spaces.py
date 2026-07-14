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
from mirage.resource.hf_spaces import HfSpacesConfig, HfSpacesResource
from mirage.types import PathSpec

load_dotenv(".env.development")

config = HfSpacesConfig(
    repo_id=os.environ.get("HF_SPACE_REPO", "HuggingFaceBio/carbon-demo"),
    token=os.environ.get("HF_TOKEN"),
)
resource = HfSpacesResource(config)
ws = Workspace({"/s/": resource}, mode=MountMode.READ)


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
    print(f"=== mounted {resource.accessor.bucket_uri} at /s/ ===")

    print("\n=== not-found errors show the full virtual path ===")
    for cmd in ("cat /s/__nf_missing__.txt", "head /s/__nf_missing__.txt",
                "stat /s/__nf_missing__.txt"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ── discover structure ──────────────────────────────
    print("\n=== ls /s/ ===")
    r = await ws.execute("ls /s/")
    print(await r.stdout_str())

    print("=== ls -lh /s/ ===")
    r = await ws.execute("ls -lh /s/")
    print(await r.stdout_str())

    print("=== tree -L 2 /s/ ===")
    r = await ws.execute("tree -L 2 /s/")
    print((await r.stdout_str())[:600])

    # ── stat ────────────────────────────────────────────
    print("\n=== stat /s/README.md ===")
    r = await ws.execute("stat /s/README.md")
    print(f"  {(await r.stdout_str()).strip()}")

    # chmod/chown/touch never hit the Hub API: attrs land in the
    # workspace namespace (durable, snapshot-captured) and merge into
    # dispatch-level stat.
    print("=== metadata overlay on /s/README.md ===")
    meta_res = await ws.execute('chmod 640 "/s/README.md"'
                                ' && chown 500:dev "/s/README.md"'
                                ' && touch -t 202601021530 "/s/README.md"')
    print(f"  chmod/chown/touch exit={meta_res.exit_code}")
    meta_st, _ = await ws.dispatch("stat",
                                   PathSpec.from_str_path("/s/README.md"))
    print(f"  dispatch stat: mode={oct(meta_st.mode)[2:]} uid={meta_st.uid} "
          f"gid={meta_st.gid} mtime={meta_st.modified}")

    # ── find variants ───────────────────────────────────
    print("\n=== find /s/ -type d ===")
    r = await ws.execute("find /s/ -type d")
    print(await r.stdout_str())

    print("=== find /s/ -name '*.py' ===")
    r = await ws.execute("find /s/ -name '*.py'")
    print(await r.stdout_str())

    print("=== find /s/ -name '*.html' | wc -l ===")
    r = await ws.execute("find /s/ -name '*.html' | wc -l")
    print(f"  html count: {(await r.stdout_str()).strip()}")

    print("=== find /s/ -maxdepth 1 -type f ===")
    r = await ws.execute("find /s/ -maxdepth 1 -type f")
    print(await r.stdout_str())

    # ── cat / head / tail / wc ──────────────────────────
    print("\n=== cat /s/README.md | head -n 15 ===")
    r = await ws.execute("cat /s/README.md | head -n 15")
    print(await r.stdout_str())

    print("=== wc -l /s/README.md ===")
    r = await ws.execute("wc -l /s/README.md")
    print(f"  {(await r.stdout_str()).strip()}")

    print("=== cat /s/requirements.txt ===")
    r = await ws.execute("cat /s/requirements.txt 2>/dev/null"
                         " || echo '(no requirements.txt)'")
    print((await r.stdout_str()).rstrip())

    # ── grep across app code ────────────────────────────
    print("\n=== grep -l import /s/*.py ===")
    r = await ws.execute("grep -l import /s/*.py 2>/dev/null")
    print(await r.stdout_str())

    print("=== grep -c '^import\\|^from' /s/app.py ===")
    r = await ws.execute("grep -c '^import\\|^from' /s/app.py"
                         " 2>/dev/null || echo 0")
    print(f"  import lines: {(await r.stdout_str()).strip()}")

    print("=== grep -ic flask /s/app.py ===")
    r = await ws.execute("grep -ic flask /s/app.py 2>/dev/null || echo 0")
    print(f"  flask matches: {(await r.stdout_str()).strip()}")

    # ── pipelines ───────────────────────────────────────
    print("\n=== find /s/ -name '*.py' | sort | head -n 5 ===")
    r = await ws.execute("find /s/ -name '*.py' | sort | head -n 5")
    print(await r.stdout_str())

    print("=== cat /s/README.md | grep -i '^#' | head -n 10 ===")
    r = await ws.execute("cat /s/README.md | grep -i '^#' | head -n 10")
    print(await r.stdout_str())

    # ── cd + relative paths ─────────────────────────────
    print("=== cd /s; pwd; ls | head ===")
    await ws.execute("cd /s")
    r = await ws.execute("pwd")
    print(f"  pwd: {(await r.stdout_str()).strip()}")
    r = await ws.execute("ls | head -n 5")
    print(f"  ls (relative):\n{(await r.stdout_str()).rstrip()}")

    # ── barriers + semicolons ───────────────────────────
    print("\n=== grep -q app /s/README.md && echo 'mentions app' ===")
    r = await ws.execute("grep -q app /s/README.md && echo 'mentions app'")
    print(f"  stdout: {(await r.stdout_str()).strip()}  exit: {r.exit_code}")

    print("=== grep -q nonexistent /s/README.md || echo 'absent' ===")
    r = await ws.execute("grep -q nonexistent /s/README.md"
                         " || echo 'absent'")
    print(f"  stdout: {(await r.stdout_str()).strip()}  exit: {r.exit_code}")

    # ── quoting + command substitution ──────────────────
    print("\n=== quoting + $() ===")
    await ws.execute("export README=/s/README.md")
    r = await ws.execute('wc -l "$README"')
    print(f'  wc -l "$README": {(await r.stdout_str()).strip()}')

    r = await ws.execute("head -n 1 $(echo /s/README.md)")
    print(f"  head -n 1 $(echo /s/README.md): "
          f"{(await r.stdout_str()).strip()}")

    # ── background jobs ─────────────────────────────────
    print("\n=== background: wc + grep in parallel ===")
    r = await ws.execute("wc -l /s/README.md &"
                         " grep -c '^#' /s/README.md &"
                         " wait; echo done")
    print(f"  stdout: {(await r.stdout_str()).strip()}")

    # ── PROVISION ───────────────────────────────────────
    print("\n=== PROVISION (plan without executing) ===")
    await ws.cache.clear()
    before = ops_summary()

    dr = await ws.execute("cat /s/README.md", provision=True)
    show_plan("cat /s/README.md", dr)

    dr = await ws.execute("head -c 100 /s/README.md", provision=True)
    show_plan("head -c 100 /s/README.md (byte budget, EXACT)", dr)

    dr = await ws.execute("ls /s/", provision=True)
    show_plan("ls /s/ (metadata only)", dr)

    dr = await ws.execute("find /s/ -name '*.py'", provision=True)
    show_plan("find /s/ -name '*.py' (metadata only)", dr)

    dr = await ws.execute("grep -l import /s/*.py", provision=True)
    show_plan("grep -l import /s/*.py", dr)

    print(f"\n  before plans: {before}")
    print(f"  after plans:  {ops_summary()}  (planning is read-free)")

    # ── streaming chains ────────────────────────────────
    print("\n=== STREAMING (chain backpressure) ===")
    target = "/s/README.md"

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
    await measure("cat | head -n 1", f"cat {target} | head -n 1")
    await ws.cache.clear()
    await measure("cat | grep '^#' | head -n 1",
                  f"cat {target} | grep '^#' | head -n 1")
    await ws.cache.clear()
    await measure("4-stage: cat|tr|grep|head -n 1",
                  f"cat {target} | tr A-Z a-z | grep app | head -n 1")

    print(f"\nFinal: {ops_summary()}")


if __name__ == "__main__":
    asyncio.run(main())
