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
import sys
import tempfile

from mirage import MountMode, Workspace
from mirage.config import load_config
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource

_fail = 0


def check(label: str, cond: bool) -> None:
    global _fail
    if cond:
        print(f"OK   {label}")
    else:
        _fail += 1
        print(f"FAIL {label}")


async def _out(ws: Workspace, cmd: str, stdin: bytes | None = None) -> str:
    res = await ws.execute(cmd, stdin=stdin)
    return await res.stdout_str()


async def default_root_is_ram() -> None:
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    root = ws._registry.root_mount
    check("default: root mounted at /", root is not None
          and root.prefix == "/")
    check("default: root backed by ram",
          type(root.resource).__name__ == "RAMResource")
    check("default: root is a normal mount entry", root
          in ws._registry.mounts())
    ls = await _out(ws, "ls /")
    check("default: ls / lists child mounts", "data" in ls and "dev" in ls)
    check("default: ls / hides dotfile mounts", ".bash_history" not in ls)
    await ws.execute("echo scratch > /note.txt")
    check("default: write to unmounted / lands on root scratch",
          (await _out(ws, "cat /note.txt")).strip() == "scratch")
    wc = await _out(ws, "wc -c", stdin=b"abcd")
    check("default: arg-less command resolves at root", wc.strip() == "4")
    await ws.close()


async def ram_root_override() -> None:
    ws = Workspace({
        "/": RAMResource(),
        "/sub/": RAMResource()
    },
                   mode=MountMode.WRITE)
    root = ws._registry.root_mount
    check(
        "ram-root: / is the user mount (not duplicated)", root is not None
        and root.prefix == "/"
        and len([m for m in ws._registry.mounts() if m.prefix == "/"]) == 1)
    await ws.execute("echo hi > /top.txt")
    await ws.execute("echo deep > /sub/inner.txt")
    check("ram-root: read file written at root",
          (await _out(ws, "cat /top.txt")).strip() == "hi")
    ls = await _out(ws, "ls /")
    check("ram-root: ls / shows root file and child mount", "top.txt" in ls
          and "sub" in ls)
    check("ram-root: read through child mount",
          (await _out(ws, "cat /sub/inner.txt")).strip() == "deep")
    await ws.close()


async def disk_root_override() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        ws = Workspace({"/": DiskResource(root=tmp)}, mode=MountMode.WRITE)
        root = ws._registry.root_mount
        check("disk-root: root backed by disk",
              type(root.resource).__name__ == "DiskResource")
        await ws.execute("echo persisted > /file.txt")
        check("disk-root: read file back through root",
              (await _out(ws, "cat /file.txt")).strip() == "persisted")
        on_disk = os.path.join(tmp, "file.txt")
        check("disk-root: write at / persisted to the real disk path",
              os.path.exists(on_disk))
        if os.path.exists(on_disk):
            with open(on_disk) as f:
                check("disk-root: on-disk content matches",
                      f.read().strip() == "persisted")
        await ws.close()


async def yaml_controls_root() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        cfg = load_config(
            {"mounts": {
                "/": {
                    "resource": "disk",
                    "config": {
                        "root": tmp
                    }
                }
            }})
        kwargs = cfg.to_workspace_kwargs()
        check("yaml: '/' mount present in resources", "/"
              in kwargs["resources"])
        ws = Workspace(**kwargs)
        root = ws._registry.root_mount
        check("yaml: root overridden to disk via config",
              type(root.resource).__name__ == "DiskResource")
        await ws.execute("echo fromyaml > /y.txt")
        check("yaml: write at / persisted to disk",
              os.path.exists(os.path.join(tmp, "y.txt")))
        await ws.close()

    ws = Workspace(**load_config({
        "mounts": {
            "/data": {
                "resource": "ram"
            }
        }
    }).to_workspace_kwargs())
    root = ws._registry.root_mount
    check("yaml: no '/' mount falls back to ram root",
          type(root.resource).__name__ == "RAMResource")
    await ws.close()


async def main() -> None:
    await default_root_is_ram()
    await ram_root_override()
    await disk_root_override()
    await yaml_controls_root()
    if _fail:
        print(f"\n{_fail} check(s) failed")
        sys.exit(1)
    print("\nroot mount OK")


if __name__ == "__main__":
    asyncio.run(main())
