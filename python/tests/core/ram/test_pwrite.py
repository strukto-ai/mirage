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
import tracemalloc

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.pwrite import pwrite
from mirage.errors.types import QuotaExceededError
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram.store import RAMStore
from tests.fixtures.ram_capacity import capped, ram_path, table_bytes

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


@pytest.mark.asyncio
async def test_pwrite_into_a_discarding_device_pads_nothing():
    store = DevStore(DevFiles("owner"))
    null = PathSpec(vfs_path="null", virtual="/dev/null", directory="/dev/")
    tracemalloc.start()
    try:
        await pwrite(RAMAccessor(store), null, b"x", 64 << 20)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 1 << 20
    assert store.files["/null"] == b""


@pytest.mark.asyncio
async def test_a_capped_pwrite_charges_only_its_growth():
    accessor, usage = capped(10, {"/f": b"12345678"})
    await pwrite(accessor, ram_path("/f"), b"ab", 2)
    await pwrite(accessor, ram_path("/f"), b"xyz", 7)
    assert accessor.store.files["/f"] == b"12ab567xyz"
    assert usage.used == table_bytes(accessor) == 10
    with pytest.raises(QuotaExceededError):
        await pwrite(accessor, ram_path("/f"), b"q", 10)
    assert accessor.store.files["/f"] == b"12ab567xyz"


@pytest.mark.asyncio
async def test_a_sparse_pwrite_past_the_cap_is_refused_before_it_builds():
    accessor, usage = capped(10)
    with pytest.raises(QuotaExceededError):
        await pwrite(accessor, ram_path("/f"), b"x", 1 << 40)
    assert "/f" not in accessor.store.files
    assert usage.used == 0


@pytest.mark.asyncio
async def test_an_empty_pwrite_past_the_end_changes_nothing():
    accessor, usage = capped(0, {"/f": b""})
    await pwrite(accessor, ram_path("/f"), b"", 1 << 40)
    assert accessor.store.files["/f"] == b""
    assert usage.used == 0
