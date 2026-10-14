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

import pytest

from mirage import Mount, MountMode, Workspace
from mirage.cache.index import NULL_INDEX
from mirage.errors.fs import exdev
from mirage.types import PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS


class StoreRAM(RAMVFS):
    """A RAM store that copies from another of its kind, store to store."""

    def __init__(self, refuse: bool = False) -> None:
        super().__init__()
        self.refuse = refuse
        self.copied: list[tuple[str, str]] = []
        self.reads: list[str] = []

    async def read(self, path, index=NULL_INDEX, offset=0, size=None):
        self.reads.append(path.virtual)
        return await super().read(path, index, offset, size)

    async def copy_from(
        self, source: BaseVFS, src: PathSpec, dst: PathSpec
    ) -> None:
        if self.refuse or not isinstance(source, StoreRAM):
            raise exdev(dst)
        self.copied.append((src.vfs_path, dst.vfs_path))
        await self.write(dst, source._store.files["/" + src.vfs_path])


async def _seeded(a: StoreRAM, b: RAMVFS, mode: MountMode = MountMode.WRITE):
    ws = Workspace(
        {"/a/": a, "/b/": Mount(b, mode=mode)}, mode=MountMode.WRITE
    )
    io = await ws.shell("printf 'payload\\n' > /a/f")
    assert io.exit_code == 0, io.stderr
    a.reads.clear()
    return ws


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["cp /a/f /b/g", "mv /a/f /b/g"])
async def test_a_copy_between_two_stores_moves_no_bytes(line):
    a, b = StoreRAM(), StoreRAM()
    ws = await _seeded(a, b)
    io = await ws.shell(line)
    assert io.exit_code == 0, io.stderr
    assert b.copied == [("f", "g")]
    assert a.reads == []
    assert (await ws.shell("cat /b/g")).stdout == b"payload\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("b", [StoreRAM(refuse=True), RAMVFS()])
async def test_a_store_that_cannot_copy_moves_the_bytes(b):
    a = StoreRAM()
    ws = await _seeded(a, b)
    io = await ws.shell("cp /a/f /b/g")
    assert io.exit_code == 0, io.stderr
    assert a.reads == ["/a/f"]
    assert (await ws.shell("cat /b/g")).stdout == b"payload\n"


@pytest.mark.asyncio
async def test_a_read_only_destination_refuses_the_store_copy():
    a, b = StoreRAM(), StoreRAM()
    ws = await _seeded(a, b, MountMode.READ)
    io = await ws.shell("cp /a/f /b/g")
    assert io.exit_code == 1
    assert b.copied == []


@pytest.mark.asyncio
async def test_a_hidden_destination_refuses_the_store_copy():
    a, b = StoreRAM(), StoreRAM()
    ws = await _seeded(a, b)
    session = ws.create_session("s", profile={"paths": {"hide": ["/b/g"]}})
    io = await ws.shell("cp /a/f /b/g", session_id=session.session_id)
    assert io.exit_code == 1
    assert b.copied == []
