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
import os
import shutil
import tempfile
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.resource.disk import DiskResource

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = REPO_ROOT / "data"

tmp = tempfile.mkdtemp()
shutil.copytree(DATA_DIR, Path(tmp) / "files", dirs_exist_ok=True)

resource = DiskResource(root=tmp + "/files")


async def main() -> None:
    ws = Workspace({"/data/": resource}, mode=MountMode.READ)

    print("=== ls /data/ ===")
    result = await ws.execute("ls /data/")
    print(await result.stdout_str())

    print("=== cat /data/example.json ===")
    result = await ws.execute("cat /data/example.json")
    print(await result.stdout_str())

    print("=== head -n 3 /data/example.jsonl ===")
    result = await ws.execute("head -n 3 /data/example.jsonl")
    print(await result.stdout_str())

    print("=== tail -n 2 /data/example.jsonl ===")
    result = await ws.execute("tail -n 2 /data/example.jsonl")
    print(await result.stdout_str())

    print("=== wc /data/example.json ===")
    result = await ws.execute("wc /data/example.json")
    print(await result.stdout_str())

    print("=== stat /data/example.json ===")
    result = await ws.execute("stat /data/example.json")
    print(await result.stdout_str())

    print("=== tree /data/ ===")
    result = await ws.execute("tree /data/")
    print(await result.stdout_str())

    print("=== find /data/ -name '*.json' ===")
    result = await ws.execute("find /data/ -name '*.json'")
    print(await result.stdout_str())

    print("=== grep example /data/example.json ===")
    result = await ws.execute("grep example /data/example.json")
    print(await result.stdout_str())

    print("=== rg example /data/example.json ===")
    result = await ws.execute("rg example /data/example.json")
    print(await result.stdout_str())

    print("=== du /data/ ===")
    result = await ws.execute("du /data/")
    print(await result.stdout_str())

    print("=== jq .company /data/example.json ===")
    result = await ws.execute('jq ".company" /data/example.json')
    print(await result.stdout_str())

    print("=== basename /data/example.json ===")
    result = await ws.execute("basename /data/example.json")
    print(await result.stdout_str())

    print("=== dirname /data/example.json ===")
    result = await ws.execute("dirname /data/example.json")
    print(await result.stdout_str())

    print("=== sort /data/example.jsonl ===")
    result = await ws.execute("sort /data/example.jsonl")
    print(await result.stdout_str())

    print("=== cp /data/example.json /data/copy.json ===")
    await ws.execute("cp /data/example.json /data/copy.json")
    result = await ws.execute("ls /data/")
    print(await result.stdout_str())

    print("=== mv /data/copy.json /data/renamed.json ===")
    await ws.execute("mv /data/copy.json /data/renamed.json")
    result = await ws.execute("ls /data/")
    print(await result.stdout_str())

    print("=== rm /data/renamed.json ===")
    await ws.execute("rm /data/renamed.json")
    result = await ws.execute("ls /data/")
    print(await result.stdout_str())

    print("=== not-found errors show the full virtual path ===")
    for cmd in ("cat /data/missing.json", "head /data/missing.json",
                "stat /data/missing.json"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    print("=== metadata writes refuse on read-only mounts ===")
    for cmd in ("chmod 600 /data/example.json",
                "chown 500:dev /data/example.json",
                "touch -t 202601021530 /data/example.json"):
        result = await ws.execute(cmd)
        print(f"$ {cmd}")
        print(f"  exit={result.exit_code}  "
              f"{(await result.stderr_str()).strip()}")

    # ── persistence: save / load / copy / deepcopy ──────────────────
    # Disk has no redacted config: full file tree is in the snapshot.
    # Default load behavior creates a fresh tmpdir. Caller can override
    # by supplying DiskResource(root=...) in resources={...}.
    print("\n=== PERSISTENCE ===\n")
    with tempfile.NamedTemporaryFile(suffix=".tar", delete=False) as f:
        snap = f.name
    custom_root = tempfile.mkdtemp(prefix="mirage-disk-restore-")
    try:
        await ws.snapshot(snap)
        print(f"  saved → {snap} ({os.path.getsize(snap)} bytes)")

        # Load with default fresh tmpdir
        loaded_default = await Workspace.load(snap)
        r = await loaded_default.execute("ls /data/")
        print(f"  loaded (default tmpdir) ls: "
              f"{(await r.stdout_str()).strip()[:80]}…")

        # Load with caller-supplied root — files written into custom_root
        loaded_custom = await Workspace.load(
            snap, resources={"/data": DiskResource(root=custom_root)})
        r = await loaded_custom.execute("ls /data/")
        print(f"  loaded (root={custom_root[:40]}…) ls: "
              f"{(await r.stdout_str()).strip()[:80]}…")
        print(f"  custom_root contents: {sorted(os.listdir(custom_root))[:5]}")

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
        shutil.rmtree(custom_root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
