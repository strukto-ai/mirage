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

from mirage import MountMode, Workspace
from mirage.io import IOResult
from mirage.ops.registry import op
from mirage.resource.ram import RAMResource
from mirage.types import PathSpec

# A raw read is what read-modify-write needs: FUSE hands the merged
# buffer straight back to ``write``, which always stores, so a read that
# rendered would store the rendering over the file. Two things can serve
# a rendering, and ``raw`` has to defeat both: a filetype-scoped op the
# mount registers for the extension, and the file cache a command's
# rendered read already filled under the same path.


@op("read", resource="ram", filetype=".tally")
async def _read_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDERED"


class _CachingRAM(RAMResource):
    caches_reads = True


def _workspace(resource: RAMResource) -> Workspace:
    resource.register_op(_read_tally)
    return Workspace({"/data/": resource}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_read_resolves_the_filetype_op():
    ws = _workspace(RAMResource())
    await ws.fs.write("/data/books.tally", b"STORED")
    assert await ws.fs.read("/data/books.tally") == b"RENDERED"


@pytest.mark.asyncio
async def test_raw_read_skips_the_filetype_op():
    ws = _workspace(RAMResource())
    await ws.fs.write("/data/books.tally", b"STORED")
    assert await ws.fs.read("/data/books.tally", raw=True) == b"STORED"


@pytest.mark.asyncio
async def test_raw_read_leaves_an_unregistered_extension_alone():
    ws = _workspace(RAMResource())
    await ws.fs.write("/data/notes.txt", b"plain")
    assert await ws.fs.read("/data/notes.txt", raw=True) == b"plain"


@pytest.mark.asyncio
async def test_raw_read_is_not_served_from_the_file_cache():
    # A command's rendered read lands in the file cache keyed on the
    # path alone, so a raw read of that same path must not be served it.
    ws = _workspace(_CachingRAM())
    await ws.fs.write("/data/books.tally", b"STORED")
    # Distinct from the filetype op's own bytes, so a warm hit is
    # distinguishable from the op running again.
    await ws.apply_io(
        IOResult(reads={"/data/books.tally": b"CACHED"},
                 cache=["/data/books.tally"]))
    assert await ws.fs.read("/data/books.tally") == b"CACHED"
    assert await ws.fs.read("/data/books.tally", raw=True) == b"STORED"


@pytest.mark.asyncio
async def test_a_warm_cache_still_answers_a_ranged_read_with_the_window():
    # The cache holds the whole object; a ranged read asked for a
    # window instead of the file, so serving the file back is wrong.
    # git reads pack indexes this way (4 bytes at a known offset), and
    # the dispatcher is the door it reaches too.
    ws = _workspace(_CachingRAM())
    await ws.fs.write("/data/f.bin", b"0123456789")
    await ws.apply_io(
        IOResult(reads={"/data/f.bin": b"0123456789"}, cache=["/data/f.bin"]))
    assert await ws.fs.read("/data/f.bin", 2, 3) == b"234"
    assert await ws.fs.read("/data/f.bin") == b"0123456789"
    assert await ws.fs.read("/data/f.bin", 7) == b"789"
    assert await ws.fs.read("/data/f.bin", 2, 0) == b""
    assert await ws.fs.read("/data/f.bin", 99, 3) == b""


@pytest.mark.asyncio
async def test_a_cold_and_a_warm_ranged_read_agree():
    ws = _workspace(_CachingRAM())
    await ws.fs.write("/data/f.bin", b"0123456789")
    cold = await ws.fs.read("/data/f.bin", 2, 3)
    await ws.apply_io(
        IOResult(reads={"/data/f.bin": b"0123456789"}, cache=["/data/f.bin"]))
    assert await ws.fs.read("/data/f.bin", 2, 3) == cold
