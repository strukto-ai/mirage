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
"""One half of the cross-language index cache interop (index_store.sh).

A workspace-level Redis index config points a RAM mount's index at one
key prefix. The writer records a listing, an empty listing and the
entries under them; the reader, in the other language, attaches to the
same prefix and must read back the same facts: the entry field by field,
the listing in order, the empty listing as listed rather than missing,
an unlisted directory as not found, and its own ``invalidate`` as an
expiry the writer's listing honours while the entries stay.
"""

# ruff: noqa: E402

import sys
from pathlib import Path

_INTEG_DIR = str(Path(__file__).parent)
sys.path[:] = [p for p in sys.path if p not in (_INTEG_DIR, "")]

import asyncio
import os

from mirage import Workspace
from mirage.cache.index import (IndexEntry, LookupStatus, RedisIndexCacheStore,
                                RedisIndexConfig)
from mirage.vfs.ram import RAMVFS

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
TTL = 600.0
DIR = "/data"
EMPTY_DIR = "/data/empty"
UNLISTED_DIR = "/data/never"
FILE_NAME = "a.txt"
FOLDER_NAME = "sub"
FILE = f"{DIR}/{FILE_NAME}"
CHILDREN = [FILE, f"{DIR}/{FOLDER_NAME}"]
REMOTE_TIME = "2026-01-01T00:00:00Z"
EXTRA = {"etag": "abc"}

fail = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fail
    if ok:
        print(f"  OK   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        fail = 1


def make_store(prefix: str) -> tuple[Workspace, RedisIndexCacheStore]:
    """A RAM mount whose index the workspace config points at Redis."""
    ram = RAMVFS()
    ws = Workspace({DIR: ram},
                   index=RedisIndexConfig(url=REDIS_URL,
                                          key_prefix=prefix,
                                          ttl=TTL))
    store = ram.index
    if not isinstance(store, RedisIndexCacheStore):
        raise SystemExit(f"py: workspace index config did not reach the "
                         f"mount, got {type(store).__name__}")
    return ws, store


async def close(ws: Workspace, store: RedisIndexCacheStore) -> None:
    await store.close()
    await ws.close()


async def write(prefix: str) -> None:
    """Record one listing with a file and a folder under it, and one
    empty listing."""
    ws, store = make_store(prefix)
    file_entry = IndexEntry(id=FILE,
                            name=FILE_NAME,
                            resource_type="file",
                            remote_time=REMOTE_TIME,
                            size=6,
                            extra=dict(EXTRA))
    folder_entry = IndexEntry(id=f"{DIR}/{FOLDER_NAME}",
                              name=FOLDER_NAME,
                              resource_type="folder",
                              remote_time=REMOTE_TIME)
    await store.set_dir(DIR, [(FILE_NAME, file_entry),
                              (FOLDER_NAME, folder_entry)])
    await store.set_dir(EMPTY_DIR, [])
    listing = await store.list_dir(DIR)
    check("py write: listing reads back", listing.entries == CHILDREN,
          f"got {listing!r}")
    await close(ws, store)


async def read(prefix: str) -> None:
    """Attach to the other language's prefix and verify every fact."""
    ws, store = make_store(prefix)
    got = await store.get(FILE)
    entry = got.entry
    check(
        "py read: entry field by field", entry is not None
        and got.status is None and entry.id == FILE and entry.name == FILE_NAME
        and entry.resource_type == "file" and entry.remote_time == REMOTE_TIME
        and entry.size == 6 and entry.extra == EXTRA
        and entry.index_time != "", f"got {got!r}")
    listing = await store.list_dir(DIR)
    check("py read: listing in order", listing.status is None
          and listing.entries == CHILDREN, f"got {listing!r}")
    empty = await store.list_dir(EMPTY_DIR)
    check("py read: empty listing is listed, not missing", empty.status is None
          and empty.entries == [], f"got {empty!r}")
    missing = await store.list_dir(UNLISTED_DIR)
    check("py read: unlisted directory is not found", missing.status
          is LookupStatus.NOT_FOUND, f"got {missing!r}")
    await store.invalidate()
    stale = await store.list_dir(DIR)
    check("py read: invalidate expires the foreign listing", stale.status
          is LookupStatus.EXPIRED, f"got {stale!r}")
    kept = await store.get(FILE)
    check("py read: invalidate keeps the entries", kept.entry is not None,
          f"got {kept!r}")
    await store.clear()
    gone = await store.list_dir(DIR)
    check("py read: clear forgets the listing", gone.status
          is LookupStatus.NOT_FOUND, f"got {gone!r}")
    await close(ws, store)


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
