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
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    assert "/a.txt" in entries
    assert "/b.txt" in entries
    assert "/sub" in entries
    assert len(entries) == 3


@pytest.mark.asyncio
async def test_readdir_subdir(accessor, index):
    entries = await readdir(
        accessor,
        PathSpec(resource_path=("/sub").strip("/"),
                 virtual="/sub",
                 directory="/sub"), index)
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
        a,
        PathSpec(resource_path=("/empty").strip("/"),
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
            PathSpec(resource_path=("/nonexistent").strip("/"),
                     virtual="/nonexistent",
                     directory="/nonexistent"), index)


@pytest.mark.asyncio
async def test_readdir_deep(accessor, index):
    entries = await readdir(
        accessor,
        PathSpec(resource_path=("/sub/deep").strip("/"),
                 virtual="/sub/deep",
                 directory="/sub/deep"), index)
    assert "/sub/deep/e.txt" in entries
    assert len(entries) == 1


@pytest.mark.asyncio
async def test_readdir_cached(accessor, store, index):
    entries1 = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    store.store.files["/new.txt"] = b"new"
    entries2 = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    assert entries1 == entries2
