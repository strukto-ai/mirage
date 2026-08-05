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

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.disk.read import read_bytes, read_range
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_read_file(tmp_path):
    (tmp_path / "hello.txt").write_bytes(b"hello world")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await read_bytes(
        accessor,
        PathSpec(resource_path=mount_key("/hello.txt", "/disk"),
                 virtual="/hello.txt",
                 directory="/hello.txt"), index)
    assert result == b"hello world"


@pytest.mark.asyncio
async def test_read_file_not_found(tmp_path):
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    with pytest.raises(FileNotFoundError):
        await read_bytes(
            accessor,
            PathSpec(resource_path="missing.txt",
                     virtual="/missing.txt",
                     directory="/missing.txt"), index)


@pytest.mark.asyncio
async def test_read_with_glob_scope_and_prefix(tmp_path):
    (tmp_path / "data.bin").write_bytes(b"\x00\x01\x02")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path=mount_key("/disk/data.bin", "/disk"),
                     virtual="/disk/data.bin",
                     directory="/disk/")
    result = await read_bytes(accessor, scope, index)
    assert result == b"\x00\x01\x02"


@pytest.mark.asyncio
async def test_read_range_seeks_instead_of_reading_the_whole_file(tmp_path):
    (tmp_path / "big.bin").write_bytes(bytes(range(256)))
    accessor = DiskAccessor(tmp_path)
    result = await read_range(
        accessor,
        PathSpec(resource_path=mount_key("/big.bin", "/disk"),
                 virtual="/big.bin",
                 directory="/big.bin"), RAMIndexCacheStore(ttl=0), 10, 5)
    assert result == bytes(range(10, 15))


@pytest.mark.asyncio
async def test_read_range_without_a_size_runs_to_the_end(tmp_path):
    (tmp_path / "big.bin").write_bytes(bytes(range(256)))
    accessor = DiskAccessor(tmp_path)
    result = await read_range(
        accessor,
        PathSpec(resource_path=mount_key("/big.bin", "/disk"),
                 virtual="/big.bin",
                 directory="/big.bin"), RAMIndexCacheStore(ttl=0), 250)
    assert result == bytes(range(250, 256))


@pytest.mark.asyncio
async def test_read_range_past_the_end_is_empty(tmp_path):
    (tmp_path / "small.bin").write_bytes(b"abc")
    accessor = DiskAccessor(tmp_path)
    result = await read_range(
        accessor,
        PathSpec(resource_path=mount_key("/small.bin", "/disk"),
                 virtual="/small.bin",
                 directory="/small.bin"), RAMIndexCacheStore(ttl=0), 99, 5)
    assert result == b""


@pytest.mark.asyncio
async def test_read_range_missing_file_raises(tmp_path):
    accessor = DiskAccessor(tmp_path)
    with pytest.raises(FileNotFoundError):
        await read_range(
            accessor,
            PathSpec(resource_path="missing.bin",
                     virtual="/missing.bin",
                     directory="/missing.bin"), RAMIndexCacheStore(ttl=0), 0,
            5)
