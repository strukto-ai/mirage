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
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert result == ["/a.txt", "/b.txt"]


@pytest.mark.asyncio
async def test_directory_with_subdirectories(tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "file.txt").write_text("x")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    result = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert result == ["/file.txt", "/sub"]


@pytest.mark.asyncio
async def test_cache_hit(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=600)
    first = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    (tmp_path / "b.txt").write_text("b")
    second = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
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
            PathSpec(resource_path="file.txt",
                     virtual="/file.txt",
                     directory="/file.txt"), index)


@pytest.mark.asyncio
async def test_cache_hit_entries_stay_clean(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=600)
    spec = PathSpec(resource_path=mount_key("/data/", "/data"),
                    virtual="/data/",
                    directory="/data/")
    cold = await readdir(accessor, spec, index)
    warm = await readdir(accessor, spec, index)
    assert cold == ["/data/a.txt"]
    assert warm == cold


@pytest.mark.asyncio
async def test_cache_key_ignores_trailing_slash(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=600)
    slashed = PathSpec(resource_path=mount_key("/data/", "/data"),
                       virtual="/data/",
                       directory="/data/")
    bare = PathSpec(resource_path=mount_key("/data", "/data"),
                    virtual="/data",
                    directory="/data")
    first = await readdir(accessor, slashed, index)
    second = await readdir(accessor, bare, index)
    assert first == second == ["/data/a.txt"]


@pytest.mark.asyncio
async def test_missing_path_is_not_found(tmp_path):
    (tmp_path / "sub").mkdir()
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    # GNU `ls /nope` -> "No such file or directory", and it stays ENOENT
    # however deep the missing component is.
    for virtual in ("/nope", "/sub/nope", "/nope/deeper"):
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(resource_path=virtual.lstrip("/"),
                         virtual=virtual,
                         directory=virtual), index)


@pytest.mark.asyncio
async def test_file_component_is_not_a_directory(tmp_path):
    (tmp_path / "file.txt").write_text("x")
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    for virtual in ("/file.txt/x", "/file.txt/x/y"):
        with pytest.raises(NotADirectoryError):
            await readdir(
                accessor,
                PathSpec(resource_path=virtual.lstrip("/"),
                         virtual=virtual,
                         directory=virtual), index)


@pytest.mark.asyncio
async def test_readdir_error_reports_the_virtual_path(tmp_path):
    accessor = DiskAccessor(tmp_path)
    index = RAMIndexCacheStore(ttl=0)
    # The real filesystem path under tmp_path must never reach the operand
    # a user-facing stderr line is built from.
    with pytest.raises(FileNotFoundError) as excinfo:
        await readdir(
            accessor,
            PathSpec(resource_path="nope", virtual="/nope", directory="/nope"),
            index)
    assert str(excinfo.value) == "/nope"
    assert str(tmp_path) not in str(excinfo.value)
