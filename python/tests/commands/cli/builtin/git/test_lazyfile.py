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
from io import SEEK_CUR, SEEK_END

import pytest
import pytest_asyncio

from mirage.commands.cli.builtin.git import lazyfile
from mirage.commands.cli.builtin.git.lazyfile import LazyFile
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace

CONTENT = bytes(range(256)) * 8
PATH = "/data/blob.bin"
SMALL_BLOCK = 64


@pytest.fixture
def block_size(monkeypatch):
    """Shrink the block so a small fixture still spans several of them.

    Args:
        monkeypatch (MonkeyPatch): pytest patcher.
    """
    monkeypatch.setattr(lazyfile, "BLOCK", SMALL_BLOCK)


async def opened(ws) -> LazyFile:
    """A LazyFile over the fixture blob.

    Args:
        ws (Workspace): the workspace holding the blob.
    """
    return LazyFile(ws.dispatch, PATH, len(CONTENT),
                    asyncio.get_running_loop())


@pytest_asyncio.fixture
async def ram_ws():
    """A workspace holding one binary blob."""
    with Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE) as ws:
        await ws.fs.write(PATH, CONTENT)
        yield ws


@pytest.mark.asyncio
async def test_reading_everything_matches_the_file(ram_ws, block_size):
    f = await opened(ram_ws)
    assert await asyncio.to_thread(f.read) == CONTENT


@pytest.mark.asyncio
async def test_a_read_inside_one_block(ram_ws, block_size):
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, 4)
    assert await asyncio.to_thread(f.read, 8) == CONTENT[4:12]


@pytest.mark.asyncio
async def test_a_read_spanning_several_blocks(ram_ws, block_size):
    # The case that matters: an object in a packfile rarely sits inside
    # one block, so the reader has to stitch them together.
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, SMALL_BLOCK - 3)
    got = await asyncio.to_thread(f.read, SMALL_BLOCK * 2 + 6)
    assert got == CONTENT[SMALL_BLOCK - 3:SMALL_BLOCK * 3 + 3]


@pytest.mark.asyncio
async def test_a_block_is_fetched_once(ram_ws, block_size, monkeypatch):
    calls = []
    original = lazyfile.read_range

    async def counting(dispatch, path, offset, size):
        calls.append((offset, size))
        return await original(dispatch, path, offset, size)

    monkeypatch.setattr(lazyfile, "read_range", counting)
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, 0)
    await asyncio.to_thread(f.read, 4)
    await asyncio.to_thread(f.seek, 8)
    await asyncio.to_thread(f.read, 4)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_a_read_only_fetches_the_blocks_it_lands_in(
        ram_ws, block_size, monkeypatch):
    calls = []
    original = lazyfile.read_range

    async def counting(dispatch, path, offset, size):
        calls.append((offset, size))
        return await original(dispatch, path, offset, size)

    monkeypatch.setattr(lazyfile, "read_range", counting)
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, SMALL_BLOCK * 4)
    await asyncio.to_thread(f.read, 2)
    assert calls == [(SMALL_BLOCK * 4, SMALL_BLOCK)]


@pytest.mark.asyncio
async def test_seek_from_the_end(ram_ws, block_size):
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, -5, SEEK_END)
    assert await asyncio.to_thread(f.read) == CONTENT[-5:]


@pytest.mark.asyncio
async def test_seek_relative_to_the_position(ram_ws, block_size):
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, 10)
    await asyncio.to_thread(f.seek, 5, SEEK_CUR)
    assert await asyncio.to_thread(f.read, 3) == CONTENT[15:18]
    assert f.tell() == 18


@pytest.mark.asyncio
async def test_reading_past_the_end_stops_there(ram_ws, block_size):
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, len(CONTENT) - 3)
    assert await asyncio.to_thread(f.read, 99) == CONTENT[-3:]


@pytest.mark.asyncio
async def test_reading_at_the_end_is_empty(ram_ws, block_size):
    f = await opened(ram_ws)
    await asyncio.to_thread(f.seek, len(CONTENT))
    assert await asyncio.to_thread(f.read, 4) == b""


@pytest.mark.asyncio
async def test_an_unknown_whence_is_refused(ram_ws, block_size):
    f = await opened(ram_ws)
    with pytest.raises(ValueError):
        f.seek(0, 99)


@pytest.mark.asyncio
async def test_it_declares_itself_read_only_and_seekable(ram_ws, block_size):
    f = await opened(ram_ws)
    assert f.readable() and f.seekable()
    assert not f.writable()
