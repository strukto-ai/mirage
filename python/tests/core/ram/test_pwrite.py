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

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.pwrite import pwrite
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram.store import RAMStore

PATH = PathSpec(vfs_path="f.txt", virtual="/f.txt", directory="/")
FD = PathSpec(vfs_path="fd/63", virtual="/dev/fd/63", directory="/dev/fd/")


@pytest.mark.asyncio
async def test_pwrite_keeps_the_bytes_outside_the_window():
    accessor = RAMAccessor(RAMStore())
    accessor.store.files["/f.txt"] = b"hello"
    await pwrite(accessor, PATH, b"XY", 1)
    assert accessor.store.files["/f.txt"] == b"hXYlo"
    assert accessor.store.modified["/f.txt"].endswith("Z")


@pytest.mark.asyncio
async def test_pwrite_past_the_end_fills_zeros_and_creates():
    accessor = RAMAccessor(RAMStore())
    await pwrite(accessor, PATH, b"z", 3)
    assert accessor.store.files["/f.txt"] == b"\0\0\0z"


@pytest.mark.asyncio
async def test_pwrite_refuses_a_missing_parent():
    accessor = RAMAccessor(RAMStore())
    nested = PathSpec(
        vfs_path="no/f.txt", virtual="/no/f.txt", directory="/no/"
    )
    with pytest.raises(FileNotFoundError):
        await pwrite(accessor, nested, b"x", 0)


@pytest.mark.asyncio
async def test_pwrite_to_a_pipe_delivers_in_write_order():
    store = DevStore(DevFiles("owner"))
    target = DevicePipe(False)
    path, _ = store.files.allocate_input(target)
    assert path == FD.virtual
    consumed = asyncio.create_task(materialize(target.pipe.stream()))
    await pwrite(RAMAccessor(store), FD, b"first ", 0)
    await pwrite(RAMAccessor(store), FD, b"second", 0)
    target.pipe.end()
    assert await asyncio.wait_for(consumed, 3) == b"first second"
    assert "/fd/63" not in store.modified
