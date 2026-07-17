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
import sys
from pathlib import Path

_INTEG_DIR = str(Path(__file__).parent)
sys.path[:] = [p for p in sys.path if p not in (_INTEG_DIR, "")]

import asyncio  # noqa: E402
import os  # noqa: E402
import uuid  # noqa: E402

from mirage import MountMode, Workspace  # noqa: E402
from mirage.resource.ram import RAMResource  # noqa: E402
from mirage.workspace.store.redis import RedisWorkspaceStateStore  # noqa: E402

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
WORKSPACE_ID = "xstore"
MARKER = "xstore-history-marker"

fail = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fail
    if ok:
        print(f"  OK   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        fail = 1


def make_workspace(prefix: str) -> tuple[Workspace, RedisWorkspaceStateStore]:
    store = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    ws = Workspace({"/data": RAMResource()},
                   mode=MountMode.EXEC,
                   workspace_id=WORKSPACE_ID,
                   store=store)
    return ws, store


async def write(prefix: str) -> None:
    """Populate all four planes: observer (history), namespace (symlink),
    sessions (narrowed grant), and the workspace metadata record."""
    ws, store = make_workspace(prefix)
    result = await ws.execute(f"echo {MARKER}")
    check("py write: marker command", result.exit_code == 0)
    result = await ws.execute("tee /data/f.txt", stdin=b"shared-bytes\n")
    check("py write: seed file", result.exit_code == 0)
    result = await ws.execute("ln -s /data/f.txt /data/l.txt")
    check("py write: symlink", result.exit_code == 0)
    ws.create_session("narrow", mounts={"/data": "read"})
    await ws.flush_sessions()
    await ws.close()
    await store.close()


async def read(prefix: str) -> None:
    """Attach with only the store config + workspace id and verify every
    plane written by the other language."""
    probe = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    meta = await probe.load_meta(WORKSPACE_ID)
    check("py read: meta record found", meta is not None)
    pointer = meta.get("default_session_id") if meta is not None else None
    check("py read: default session id is uuid7",
          isinstance(pointer, str) and uuid.UUID(pointer).version == 7,
          f"got {meta!r}")
    await probe.close()

    ws, store = make_workspace(prefix)
    await ws.ensure_sessions_loaded()
    check("py read: adopted writer's default session",
          ws.default_session_id == pointer,
          f"got {ws.default_session_id!r} want {pointer!r}")
    result = await ws.execute("history")
    check("py read: history has marker", MARKER
          in result.stdout.decode(errors="replace"), f"got {result.stdout!r}")
    result = await ws.execute("readlink /data/l.txt")
    check("py read: symlink target",
          result.stdout.decode().strip() == "/data/f.txt",
          f"got {result.stdout!r}")
    await ws.ensure_sessions_loaded()
    session = ws.get_session("narrow")
    check(
        "py read: session grant narrowed", session.mount_modes is not None
        and session.mount_modes.get("/data") == MountMode.READ)
    result = await ws.execute("echo blocked > /data/x.txt",
                              session_id="narrow")
    check("py read: narrowed write denied", result.exit_code != 0)
    await ws.close()
    await store.close()


async def main() -> None:
    role = sys.argv[1]
    prefix = sys.argv[2]
    if role == "write":
        await write(prefix)
    elif role == "read":
        await read(prefix)
    else:
        raise SystemExit(f"unknown role: {role!r}")
    if fail:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
