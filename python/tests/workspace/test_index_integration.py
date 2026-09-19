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

from mirage.cache.index import LookupStatus
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


def _stdout(io):
    if io.stdout is None:
        return b""
    if isinstance(io.stdout, bytes):
        return io.stdout
    if isinstance(io.stdout, memoryview):
        return bytes(io.stdout)
    return b""


# ── RAM index integration ─────────────────────


def _ram_ws():
    p = RAMVFS()
    p._store.dirs.add("/sub")
    p._store.files["/sub/a.txt"] = b"aaa\n"
    p._store.files["/sub/b.txt"] = b"bbb\n"
    p._store.files["/sub/c.csv"] = b"col\n"
    ws = Workspace(mounts={"/data/": (p, MountMode.WRITE)}, )
    ws.get_session(ws.default_session_id).cwd = "/data"
    return ws, ws.mount("/data/").index_store


def test_ram_glob_populates_index():
    """RAM ttl=0 → index populated but expires immediately."""
    ws, index = _ram_ws()
    io = _run(ws.shell("cat /data/sub/*.txt"))
    assert io.exit_code == 0
    # ttl=0: entries were set but expired by the time we check
    # Index now stores virtual paths (with mount prefix)
    listing = _run(index.list_dir("/data/sub"))
    assert listing.status == LookupStatus.EXPIRED


def test_ram_cat_of_a_literal_path_stores_no_listing():
    """A literal path asks for no directory listing, so nothing is indexed.

    Renamed from ``test_ram_glob_second_call_uses_index``, which asserted
    nothing and could not have: the RAM VFS's ``index_ttl`` is 0, so
    an index hit is unreachable for it by construction, and ``cat`` on a
    literal path never populates a listing in the first place (the glob
    sibling above is what populates, and it reads back EXPIRED). This
    pins what the pair of runs actually establishes.
    """
    ws, index = _ram_ws()
    first = _run(ws.shell("cat /data/sub/a.txt"))
    second = _run(ws.shell("cat /data/sub/a.txt"))
    assert (first.exit_code, second.exit_code) == (0, 0)
    listing = _run(index.list_dir("/data/sub"))
    assert listing.status == LookupStatus.NOT_FOUND


def test_ram_glob_pattern_works():
    ws, _ = _ram_ws()
    io = _run(ws.shell("cat /data/sub/*.txt"))
    assert io.exit_code == 0


# ── TTL behavior ───────────────────────────────


def test_ram_index_ttl_zero():
    p = RAMVFS()
    assert p.index_ttl == 0


def test_index_expired_refetches():
    p = RAMVFS()
    p._store.dirs.add("/sub")
    p._store.files["/sub/a.txt"] = b"aaa\n"
    ws = Workspace(mounts={"/data/": (p, MountMode.WRITE)}, )
    ws.get_session(ws.default_session_id).cwd = "/data"
    _run(ws.shell("cat /data/sub/*.txt"))
    listing = _run(ws.mount("/data/").index_store.list_dir("/data/sub"))
    # RAM ttl=0 → expired immediately after set
    expired = listing.status == LookupStatus.EXPIRED
    assert expired or listing.entries is not None
