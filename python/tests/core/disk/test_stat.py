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
from mirage.core.disk.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_stat_file(tmp_path):
    (tmp_path / "hello.txt").write_text("hello")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/hello.txt", "/disk"),
                 virtual="/hello.txt",
                 directory="/hello.txt"), index)
    assert result.name == "hello.txt"
    assert result.size == 5
    assert result.modified is not None
    assert result.modified.endswith("Z")
    assert "+00:00" not in result.modified
    assert result.type != FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_directory(tmp_path):
    (tmp_path / "sub").mkdir()
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await stat(
        accessor,
        PathSpec(resource_path="sub", virtual="/sub", directory="/sub"), index)
    assert result.type == FileType.DIRECTORY
    assert result.size is None


@pytest.mark.asyncio
async def test_stat_file_not_found(tmp_path):
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path="missing.txt",
                     virtual="/missing.txt",
                     directory="/missing.txt"), index)


@pytest.mark.asyncio
async def test_stat_with_glob_scope(tmp_path):
    (tmp_path / "a.txt").write_text("data")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path=mount_key("/disk/a.txt", "/disk"),
                     virtual="/disk/a.txt",
                     directory="/disk/")
    result = await stat(accessor, scope, index)
    assert result.name == "a.txt"
    assert result.size == 4


@pytest.mark.asyncio
async def test_stat_with_prefix(tmp_path):
    (tmp_path / "a.txt").write_text("data")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key("/disk/a.txt", "/disk"),
                 virtual="/disk/a.txt",
                 directory="/disk/a.txt"), index)
    assert result.name == "a.txt"
    assert result.size == 4
