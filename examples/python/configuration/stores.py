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

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS
from mirage.workspace.store import DiskWorkspaceStateStore, RAMWorkspaceStateStore

GROUPS = ("namespace", "workspace", "observer")
PROBES = {
    "symlink": "readlink /data/link || echo gone",
    "cwd": "pwd",
    "variable": "echo ${GREETING:-gone}",
    "history": "grep -c 'first-r[u]n' /.bash_history || true",
}


def build(group: str, root: str) -> Workspace:
    """A workspace with one store group on disk and the rest in memory.

    Args:
        group (str): The group key to place on disk.
        root (str): The disk store's state directory.
    """
    store = RAMWorkspaceStateStore(**{group: DiskWorkspaceStateStore(root=root)})
    return Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        workspace_id="agent",
        session_id="main",
        store=store,
        owns_store=True,
    )


async def place(group: str) -> None:
    """Write to every store, rebuild, and show what came back.

    Args:
        group (str): The group key to place on disk.
    """
    print(f"\n=== store.{group} on disk ===")
    with tempfile.TemporaryDirectory() as root:
        ws = build(group, root)
        await ws.shell("echo first-run > /data/a.txt")
        await ws.shell("ln -s /data/a.txt /data/link")
        await ws.shell("cd /data && export GREETING=hello")
        await ws.close()

        ws = build(group, root)
        for name, line in PROBES.items():
            out = await (await ws.shell(line)).stdout_str()
            print(f"{name}: {out.strip()}")
        await ws.close()


async def main() -> None:
    for group in GROUPS:
        await place(group)


if __name__ == "__main__":
    asyncio.run(main())
