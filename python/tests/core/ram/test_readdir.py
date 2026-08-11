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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.ram.readdir import readdir
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/a.txt"] = b"a"
    s.files["/b.txt"] = b"b"
    s.dirs.add("/sub")
    s.files["/sub/c.txt"] = b"c"
    s.files["/sub/d.txt"] = b"d"
    s.dirs.add("/sub/deep")
    s.files["/sub/deep/e.txt"] = b"e"
    return a


@pytest.fixture
def accessor(store):
    return store


@pytest.fixture
def index():
    return RAMIndexCacheStore(ttl=600)


@pytest.mark.asyncio
async def test_readdir_root(accessor, store, index):
    entries = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert "/a.txt" in entries
    assert "/b.txt" in entries
    assert "/sub" in entries
    assert len(entries) == 3


@pytest.mark.asyncio
async def test_readdir_subdir(accessor, index):
    entries = await readdir(
        accessor,
        PathSpec(resource_path="sub", virtual="/sub", directory="/sub"), index)
    assert "/sub/c.txt" in entries
    assert "/sub/d.txt" in entries
    assert "/sub/deep" in entries
    assert len(entries) == 3


@pytest.mark.asyncio
async def test_readdir_empty_dir(index):
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/empty")
    a = RAMAccessor(s)
    entries = await readdir(
        a, PathSpec(resource_path="empty",
                    virtual="/empty",
                    directory="/empty"), index)
    assert entries == []


@pytest.mark.asyncio
async def test_readdir_not_found(index):
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await readdir(
            a,
            PathSpec(resource_path="nonexistent",
                     virtual="/nonexistent",
                     directory="/nonexistent"), index)


@pytest.mark.asyncio
async def test_readdir_deep(accessor, index):
    entries = await readdir(
        accessor,
        PathSpec(resource_path="sub/deep",
                 virtual="/sub/deep",
                 directory="/sub/deep"), index)
    assert "/sub/deep/e.txt" in entries
    assert len(entries) == 1


@pytest.mark.asyncio
async def test_readdir_cached(accessor, store, index):
    entries1 = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    store.store.files["/new.txt"] = b"new"
    entries2 = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert entries1 == entries2


@pytest.mark.asyncio
async def test_readdir_missing_stays_not_found_at_any_depth(index):
    s = RAMStore()
    s.files["/a.txt"] = b"a"

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await readdir(
            a,
            PathSpec(resource_path="nope/deeper",
                     virtual="/nope/deeper",
                     directory="/nope/deeper"), index)


@pytest.mark.asyncio
async def test_readdir_file_component_is_not_a_directory(index):
    # GNU `ls /a.txt/x` -> "Not a directory": a component exists but is a
    # file. Only a missing component is ENOENT.
    s = RAMStore()
    s.files["/a.txt"] = b"a"

    a = RAMAccessor(s)
    for virtual in ("/a.txt", "/a.txt/x", "/a.txt/x/y"):
        with pytest.raises(NotADirectoryError):
            await readdir(
                a,
                PathSpec(resource_path=virtual.lstrip("/"),
                         virtual=virtual,
                         directory=virtual), index)


@pytest.mark.asyncio
async def test_readdir_orphan_below_a_missing_dir_is_not_found(index):
    # The store can hold a file whose parent is not in dirs: a restored
    # snapshot or another writer can seed one, so readdir stays defensive
    # about it even though rename and copy now refuse to create one. The
    # walk must stop at /missing, the way the kernel would, instead of
    # reaching the orphan and reporting ENOTDIR.
    s = RAMStore()
    s.files["/missing/a.txt"] = b"a"

    a = RAMAccessor(s)
    for virtual in ("/missing", "/missing/a.txt/x", "/missing/a.txt/x/y"):
        with pytest.raises(FileNotFoundError):
            await readdir(
                a,
                PathSpec(resource_path=virtual.lstrip("/"),
                         virtual=virtual,
                         directory=virtual), index)
