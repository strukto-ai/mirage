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

import pytest

from mirage import Mount, MountMode, Workspace
from mirage.errors.fs import exdev
from mirage.types import Limit, PathSpec, WritePolicy
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS


class StoreRAM(RAMVFS):
    """A RAM store that copies from another of its kind, store to store."""

    def __init__(self, refuse: bool = False) -> None:
        super().__init__()
        self.refuse = refuse
        self.copied: list[tuple[str, str]] = []
        self.reads: list[str] = []

    async def read(self, path, offset=0, size=None):
        self.reads.append(path.virtual)
        return await super().read(path, offset, size)

    async def read_stream(self, path):
        self.reads.append(path.virtual)
        async for chunk in super().read_stream(path):
            yield chunk

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


def _mount(ws: Workspace, prefix: str):
    return next(m for m in ws._registry._mounts if m.prefix == prefix)


@pytest.mark.asyncio
async def test_a_cached_source_moves_the_bytes_a_read_gives():
    a, b = StoreRAM(), StoreRAM()
    a.caches_reads = True
    ws = await _seeded(a, b)
    await ws.shell("cat /a/f")
    io = await ws.shell("cp /a/f /b/g")
    assert io.exit_code == 0, io.stderr
    assert b.copied == []
    assert (await ws.shell("cat /b/g")).stdout == b"payload\n"


@pytest.mark.asyncio
async def test_a_pinned_source_moves_the_bytes():
    a, b = StoreRAM(), StoreRAM()
    ws = await _seeded(a, b)
    _mount(ws, "/a/").revisions["/a/f"] = "v1"
    io = await ws.shell("cp /a/f /b/g")
    assert io.exit_code == 0, io.stderr
    assert b.copied == []


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/a/", "/b/"])
async def test_a_conditional_mount_moves_the_bytes(prefix):
    a, b = StoreRAM(), StoreRAM()
    ws = await _seeded(a, b)
    _mount(ws, prefix).write = WritePolicy.CONDITIONAL
    await ws.shell("mv /a/f /b/g")
    assert b.copied == []


class SlowStoreRAM(StoreRAM):
    """A destination whose store copy outlasts any deadline."""

    async def copy_from(self, source, src, dst):
        await asyncio.sleep(5)


@pytest.mark.asyncio
async def test_a_store_copy_keeps_the_copy_timeout():
    a, b = StoreRAM(), SlowStoreRAM()
    ws = await _seeded(a, b)
    _mount(ws, "/b/").command_limits["copy"] = Limit(timeout_seconds=0.05)
    io = await ws.shell("cp /a/f /b/g")
    assert io.exit_code != 0


@pytest.mark.asyncio
async def test_a_rendered_source_moves_the_bytes_a_read_gives():
    a, b = StoreRAM(), StoreRAM()
    ws = await _seeded(a, b)
    a.renderers = {".txt": "read"}
    await ws.shell("printf 'payload\\n' > /a/f.txt")
    io = await ws.shell("cp /a/f.txt /b/g")
    assert io.exit_code == 0, io.stderr
    assert b.copied == []
