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
import tempfile
from pathlib import Path

from mirage import DiskVFS, MountMode, Workspace
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS


@command("greet", vfs=["ram", "disk"], spec=SPECS["cat"])
async def greet(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
):
    backend = type(accessor).__name__
    targets = ", ".join(p.virtual for p in paths) if paths else "(no paths)"
    body = f"hello from {backend}: {targets}\n".encode()
    return body, IOResult()


async def main():
    tmp_root = Path(tempfile.mkdtemp(prefix="mirage-custom-cmd-"))
    (tmp_root / "note.txt").write_text("disk file\n")

    ws = Workspace(
        {
            "/ram/": RAMVFS(),
            "/disk/": DiskVFS(str(tmp_root)),
        },
        mode=MountMode.WRITE,
    )

    print("=== decorator-level bindings on greet ===")
    for rc in greet._registered_commands:
        print(f"  VFS={rc.vfs!r:10}  name={rc.name!r}")

    ws.mount("/ram/").register_fns([greet])
    ws.mount("/disk/").register_fns([greet])

    await ws.shell("echo content > /ram/note.txt")

    print("\n=== greet on /ram/ (RAMAccessor wins) ===")
    result = await ws.shell("greet /ram/note.txt")
    print(await result.stdout_str())

    print("=== greet on /disk/ (DiskAccessor wins) ===")
    result = await ws.shell("greet /disk/note.txt")
    print(await result.stdout_str())


asyncio.run(main())
