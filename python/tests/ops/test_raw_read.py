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
    await ws.ops.write("/data/books.tally", b"STORED")
    assert await ws.ops.read("/data/books.tally") == b"RENDERED"


@pytest.mark.asyncio
async def test_raw_read_skips_the_filetype_op():
    ws = _workspace(RAMResource())
    await ws.ops.write("/data/books.tally", b"STORED")
    assert await ws.ops.read("/data/books.tally", raw=True) == b"STORED"


@pytest.mark.asyncio
async def test_raw_read_leaves_an_unregistered_extension_alone():
    ws = _workspace(RAMResource())
    await ws.ops.write("/data/notes.txt", b"plain")
    assert await ws.ops.read("/data/notes.txt", raw=True) == b"plain"


@pytest.mark.asyncio
async def test_raw_read_is_not_served_from_the_file_cache():
    # A command's rendered read lands in the file cache keyed on the
    # path alone, so a raw read of that same path must not be served it.
    ws = _workspace(_CachingRAM())
    await ws.ops.write("/data/books.tally", b"STORED")
    # Distinct from the filetype op's own bytes, so a warm hit is
    # distinguishable from the op running again.
    await ws.apply_io(
        IOResult(reads={"/data/books.tally": b"CACHED"},
                 cache=["/data/books.tally"]))
    assert await ws.ops.read("/data/books.tally") == b"CACHED"
    assert await ws.ops.read("/data/books.tally", raw=True) == b"STORED"
