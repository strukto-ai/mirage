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

import errno

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.truncate import truncate
from mirage.errors.types import QuotaExceededError
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram.store import RAMStore
from tests.fixtures.ram_capacity import capped, ram_path, table_bytes

FD = PathSpec(vfs_path="fd/63", virtual="/dev/fd/63", directory="/dev/fd/")


@pytest.mark.asyncio
async def test_truncate_to_zero_empties_the_file():
    s = RAMStore()
    a = RAMAccessor(s)
    s.files["/t.txt"] = b"previous"
    await truncate(a, PathSpec.from_str_path("/t.txt"), 0)
    assert s.files["/t.txt"] == b""


@pytest.mark.asyncio
async def test_truncate_extends_with_nul_bytes():
    s = RAMStore()
    a = RAMAccessor(s)
    s.files["/t.txt"] = b"ab"
    await truncate(a, PathSpec.from_str_path("/t.txt"), 4)
    assert s.files["/t.txt"] == b"ab\x00\x00"


@pytest.mark.asyncio
async def test_truncate_onto_a_directory_is_a_directory():
    s = RAMStore()
    a = RAMAccessor(s)
    s.dirs.add("/d")
    with pytest.raises(IsADirectoryError):
        await truncate(a, PathSpec.from_str_path("/d"), 0)
    assert "/d" not in s.files


@pytest.mark.asyncio
async def test_truncate_records_its_own_op():
    # The op used to leave no record at all, so a guest's 'w' open on
    # an existing file was invisible to the ledger while the same open
    # on a missing file was not.
    s = RAMStore()
    a = RAMAccessor(s)
    s.files["/t.txt"] = b"previous"
    scope = RecordingScope()
    await truncate(a, PathSpec.from_str_path("/t.txt"), 0)
    scope.close()
    assert [r.op for r in scope.records] == ["truncate"]
    assert scope.records[0].bytes == 0
    assert scope.records[0].source == "ram"


@pytest.mark.asyncio
@pytest.mark.parametrize("readable", [True, False])
async def test_truncate_of_a_pipe_is_einval(readable):
    store = DevStore(DevFiles("owner"))
    endpoint = DevicePipe(readable)
    store.files.allocate_input(endpoint)
    with pytest.raises(OSError) as caught:
        await truncate(RAMAccessor(store), FD, 0)
    assert caught.value.errno == errno.EINVAL
    assert store.files.pipe_of("/fd/63") is endpoint


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [-1, -100, 2.5])
async def test_an_invalid_length_is_einval_and_charges_nothing(length):
    accessor, usage = capped(4, {"/f": b"1234"})
    usage.used = 4
    with pytest.raises(OSError) as caught:
        await truncate(accessor, ram_path("/f"), length)
    assert caught.value.errno == errno.EINVAL
    assert accessor.store.files["/f"] == b"1234"
    assert usage.used == table_bytes(accessor) == 4


@pytest.mark.asyncio
async def test_a_capped_length_change_charges_its_growth():
    accessor, usage = capped(10, {"/f": b"123"})
    await truncate(accessor, ram_path("/f"), 8)
    assert usage.used == table_bytes(accessor) == 8
    with pytest.raises(QuotaExceededError):
        await truncate(accessor, ram_path("/f"), 11)
    assert accessor.store.files["/f"] == b"123\0\0\0\0\0"


@pytest.mark.asyncio
async def test_a_shortening_passes_over_the_cap():
    accessor, usage = capped(2, {"/f": b"1234567890"})
    await truncate(accessor, ram_path("/f"), 4)
    assert usage.used == table_bytes(accessor) == 4


@pytest.mark.asyncio
async def test_a_sparse_length_past_the_cap_is_refused_before_it_builds():
    accessor, usage = capped(10)
    with pytest.raises(QuotaExceededError):
        await truncate(accessor, ram_path("/f"), 1 << 40)
    assert "/f" not in accessor.store.files
    assert usage.used == 0


@pytest.mark.asyncio
async def test_a_no_create_length_change_on_a_missing_file_charges_nothing():
    accessor, usage = capped(10)
    await truncate(accessor, ram_path("/f"), 4, no_create=True)
    assert "/f" not in accessor.store.files
    assert usage.used == 0
