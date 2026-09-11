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

import os

import pytest

from mirage import MountMode, Workspace
from mirage.resource.disk import DiskResource
from mirage.types import PathSpec

# The ops factory forwards the index cache store into read/readdir/stat for
# every backend. Disk carries a 60s index TTL, so a cached listing would hide
# a mutation for a full minute unless something evicts it. Both surfaces do,
# and for one reason: ``dispatch`` and the VFS/FUSE ``Ops`` facade are the
# same door, so every write goes through Dispatcher.invalidate_after_write.
# TS mirrors this file, and now the whole of it, in
# packages/node/src/ops/index_invalidation.test.ts.


def _spec(virtual: str, rel: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, resource_path=rel)


def _names(entries: list[str]) -> list[str]:
    return sorted(str(e).rstrip("/").rsplit("/", 1)[-1] for e in entries)


@pytest.fixture
def disk_ws(tmp_path):
    os.mkdir(tmp_path / "seed")
    return Workspace({"/d/": DiskResource(root=str(tmp_path))},
                     mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_readdir_sees_dir_created_after_listing_cached(disk_ws):
    before, _ = await disk_ws.dispatch("readdir", _spec("/d/", ""))
    assert _names(before) == ["seed"]
    await disk_ws.dispatch("mkdir", _spec("/d/fresh", "fresh"))
    after, _ = await disk_ws.dispatch("readdir", _spec("/d/", ""))
    assert _names(after) == ["fresh", "seed"]


@pytest.mark.asyncio
async def test_readdir_sees_file_written_after_listing_cached(disk_ws):
    before, _ = await disk_ws.dispatch("readdir", _spec("/d/", ""))
    assert _names(before) == ["seed"]
    await disk_ws.dispatch("write",
                           _spec("/d/note.txt", "note.txt"),
                           data=b"hi")
    after, _ = await disk_ws.dispatch("readdir", _spec("/d/", ""))
    assert _names(after) == ["note.txt", "seed"]


@pytest.mark.asyncio
async def test_readdir_drops_dir_removed_after_listing_cached(disk_ws):
    await disk_ws.dispatch("mkdir", _spec("/d/gone", "gone"))
    before, _ = await disk_ws.dispatch("readdir", _spec("/d/", ""))
    assert _names(before) == ["gone", "seed"]
    await disk_ws.dispatch("rmdir", _spec("/d/gone", "gone"))
    after, _ = await disk_ws.dispatch("readdir", _spec("/d/", ""))
    assert _names(after) == ["seed"]


@pytest.mark.asyncio
async def test_ops_facade_readdir_reflects_mkdir(disk_ws):
    assert _names(await disk_ws.fs.readdir("/d/")) == ["seed"]
    await disk_ws.fs.mkdir("/d/sub")
    assert _names(await disk_ws.fs.readdir("/d/")) == ["seed", "sub"]


@pytest.mark.asyncio
async def test_ops_facade_readdir_reflects_write_then_unlink(disk_ws):
    await disk_ws.fs.write("/d/a.txt", b"a")
    assert _names(await disk_ws.fs.readdir("/d/")) == ["a.txt", "seed"]
    await disk_ws.fs.unlink("/d/a.txt")
    assert _names(await disk_ws.fs.readdir("/d/")) == ["seed"]
