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
from mirage.core.disk.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_empty_directory(tmp_path):
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await readdir(
        accessor,
        PathSpec(resource_path=mount_key("/", "/disk"),
                 virtual="/",
                 directory="/"), index)
    assert result == []


@pytest.mark.asyncio
async def test_directory_with_files(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "b.txt").write_text("b")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    assert result == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_directory_with_subdirectories(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "file.txt").write_text("x")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    assert result == ["/file.txt", "/sub"]


@pytest.mark.asyncio
async def test_cache_hit(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=600)
    first = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    (tmp_path / "b.txt").write_text("b")
    second = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    assert first == second


@pytest.mark.asyncio
async def test_with_prefix(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await readdir(
        accessor,
        PathSpec(resource_path=mount_key("/disk/", "/disk"),
                 virtual="/disk/",
                 directory="/disk/"), index)
    assert result == ["/disk/a.txt"]


@pytest.mark.asyncio
async def test_with_glob_scope(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    scope = PathSpec(resource_path=mount_key("/disk/", "/disk"),
                     virtual="/disk/",
                     directory="/disk/")
    result = await readdir(accessor, scope, index)
    assert result == ["/disk/a.txt"]


@pytest.mark.asyncio
async def test_not_a_directory(tmp_path):
    (tmp_path / "file.txt").write_text("x")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    with pytest.raises(NotADirectoryError):
        await readdir(
            accessor,
            PathSpec(resource_path=("/file.txt").strip("/"),
                     virtual="/file.txt",
                     directory="/file.txt"), index)
