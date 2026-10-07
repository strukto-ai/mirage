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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ram.read import read as ram_read
from mirage.core.ram.readdir import readdir as ram_readdir
from mirage.core.ram.stat import stat as ram_stat
from mirage.core.ram.write import write as ram_write
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.ranges import slice_window
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from mirage.vfs.testing import ReadFixture, check_read_contract

FILE = PathSpec(virtual="/data/a.txt", directory="/data", vfs_path="a.txt")
DIRECTORY = PathSpec(virtual="/data", directory="/", vfs_path="")
MISSING = PathSpec(
    virtual="/data/missing", directory="/data", vfs_path="missing"
)
CONTENT = "é: hello\n".encode()
FIXTURE = ReadFixture(FILE, DIRECTORY, MISSING, CONTENT)


class Minimal(BaseVFS):
    """The three required reads over a RAM store, whole reads sliced."""

    name = "custom"

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await ram_readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await ram_read(self.accessor, path, index)
        return slice_window(data, offset, size)

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await ram_stat(self.accessor, path, index)


class EndForSize(Minimal):
    reads_ranges = True

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await ram_read(self.accessor, path, index)
        return data[offset:size]


class LenientStat(Minimal):
    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        if path.vfs_path == MISSING.vfs_path:
            return FileStat(name="missing", type=FileType.FILE, size=0)
        return await super().stat(path, index)


async def _seeded(cls: type[BaseVFS], content: bytes) -> BaseVFS:
    store = RAMStore()
    accessor = RAMAccessor(store)
    await ram_write(accessor, FILE, content)
    return cls(accessor=accessor)


@pytest.mark.asyncio
@pytest.mark.parametrize("content", [b"", b"a", b"ab", CONTENT])
async def test_a_minimal_vfs_meets_the_contract(content):
    vfs = await _seeded(Minimal, content)
    await check_read_contract(
        vfs, FIXTURE.__class__(FILE, DIRECTORY, MISSING, content)
    )


@pytest.mark.asyncio
async def test_a_builtin_meets_the_contract():
    ram = RAMVFS()
    await ram_write(ram.accessor, FILE, CONTENT)
    await check_read_contract(ram, FIXTURE)


@pytest.mark.asyncio
async def test_the_contract_catches_ranges_using_end_instead_of_size():
    vfs = await _seeded(EndForSize, CONTENT)
    with pytest.raises(AssertionError, match="offset and byte count"):
        await check_read_contract(vfs, FIXTURE)


@pytest.mark.asyncio
async def test_the_contract_catches_a_stat_that_answers_for_a_missing_path():
    vfs = await _seeded(LenientStat, CONTENT)
    with pytest.raises(AssertionError, match="must raise FileNotFoundError"):
        await check_read_contract(vfs, FIXTURE)


@pytest.mark.asyncio
async def test_the_contract_propagates_a_permission_failure():
    vfs = await _seeded(Minimal, CONTENT)
    vfs.read = AsyncMock(side_effect=PermissionError("denied"))  # type: ignore[method-assign]
    with pytest.raises(PermissionError, match="denied"):
        await check_read_contract(vfs, FIXTURE)
