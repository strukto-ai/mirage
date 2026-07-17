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
from mirage.workspace.session.store import SessionStore  # noqa: E402
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
    shared = ws.create_session("shared")
    shared.env["ORIGIN"] = "py"
    await ws.flush_sessions()
    check("py write: shared session at generation 1", shared.generation == 1,
          f"got {shared.generation}")
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
    check("py read: generation survived the wire", session.generation >= 1,
          f"got {session.generation}")
    result = await ws.execute("echo blocked > /data/x.txt",
                              session_id="narrow")
    check("py read: narrowed write denied", result.exit_code != 0)

    # CAS against the record the other language wrote: the Lua compare
    # must parse its JSON bytes.
    shared = ws.get_session("shared")
    base = shared.generation
    check("py read: shared session hydrated",
          shared.env.get("ORIGIN") == "ts" and base >= 1,
          f"got env={shared.env!r} generation={base}")
    shared.env["REPLY"] = "py"
    await ws.flush_sessions()
    sess_store = store.sessions(WORKSPACE_ID)
    entries = await sess_store.load()
    check("py read: flush CAS-bumped the foreign record",
          entries["shared"]["generation"] == base + 1,
          f"got {entries['shared']!r}")
    stale = dict(entries["shared"])
    check("py read: stale cas_set rejected", await
          sess_store.cas_set("shared", stale, base) is False)
    # A third writer advances the record behind our back; the next
    # flush must adopt its generation and land serialized on top.
    ahead = dict(entries["shared"])
    ahead["generation"] = base + 5
    await sess_store.set("shared", ahead)
    shared.env["AGAIN"] = "py"
    await ws.flush_sessions()
    entries = await sess_store.load()
    check(
        "py read: conflict adopted and serialized",
        entries["shared"]["generation"] == base + 6
        and entries["shared"]["env"].get("AGAIN") == "py",
        f"got {entries['shared']!r}")
    await ws.close()
    await store.close()


async def cas_increment(sess: SessionStore, worker: str, rounds: int) -> None:
    """Read-modify-CAS this worker's counter, retrying until it lands."""
    for _ in range(rounds):
        for _ in range(500):
            record = (await sess.load()).get("hot", {
                "session_id": "hot",
                "env": {},
            })
            env = dict(record.get("env", {}))
            env[worker] = str(int(env.get(worker, "0")) + 1)
            expected = int(record.get("generation", 0))
            fields = dict(record)
            fields["env"] = env
            fields["generation"] = expected + 1
            if await sess.cas_set("hot", fields, expected):
                break
        else:
            raise SystemExit(f"{worker}: cas retry budget exhausted")


async def hammer(prefix: str, rounds: int) -> None:
    """Race the other language's hammer process on one shared record.

    Announce with one increment, wait until the peer's counter shows
    up (so both main loops genuinely overlap), then run the rest."""
    store = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    sess = store.sessions(WORKSPACE_ID)
    await cas_increment(sess, "py", 1)
    for _ in range(300):
        entries = await sess.load()
        if "ts" in entries.get("hot", {}).get("env", {}):
            break
        await asyncio.sleep(0.05)
    else:
        raise SystemExit("py hammer: peer never showed up")
    await cas_increment(sess, "py", rounds - 1)
    print(f"  OK   py hammer: {rounds} increments landed")
    await store.close()


async def cas_verify(prefix: str, rounds: int) -> None:
    """Both hammers done: no increment may be lost."""
    store = RedisWorkspaceStateStore(url=REDIS_URL, key_prefix=prefix)
    sess = store.sessions(WORKSPACE_ID)
    final = (await sess.load())["hot"]
    check(
        "py verify: concurrent hammers lost no updates",
        final["generation"] == 2 * rounds
        and final["env"].get("py") == str(rounds)
        and final["env"].get("ts") == str(rounds), f"got {final!r}")
    await store.close()


async def main() -> None:
    role = sys.argv[1]
    prefix = sys.argv[2]
    if role == "write":
        await write(prefix)
    elif role == "read":
        await read(prefix)
    elif role == "hammer":
        await hammer(prefix, int(sys.argv[3]))
    elif role == "cas-verify":
        await cas_verify(prefix, int(sys.argv[3]))
    else:
        raise SystemExit(f"unknown role: {role!r}")
    if fail:
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
