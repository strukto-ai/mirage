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
from mirage.core.ram.mkdir import mkdir
from mirage.core.ram.mkdir_p import mkdir_p
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_mkdir():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir(
        a,
        PathSpec(resource_path="newdir",
                 virtual="/newdir",
                 directory="/newdir"))
    assert "/newdir" in s.dirs
    assert "/newdir" in s.modified


@pytest.mark.asyncio
async def test_mkdir_parent_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError,
                       match="parent directory does not exist"):
        await mkdir(
            a,
            PathSpec(resource_path="no/parent",
                     virtual="/no/parent",
                     directory="/no/parent"))


@pytest.mark.asyncio
async def test_mkdir_already_exists():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir(
        a, PathSpec(resource_path="dir", virtual="/dir", directory="/dir"))
    await mkdir(
        a, PathSpec(resource_path="dir", virtual="/dir", directory="/dir"))
    assert "/dir" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_with_parents():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir(a,
                PathSpec(resource_path="a/b/c",
                         virtual="/a/b/c",
                         directory="/a/b/c"),
                parents=True)
    assert "/a" in s.dirs
    assert "/a/b" in s.dirs
    assert "/a/b/c" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_p():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir_p(a, "/x/y/z")
    assert "/x" in s.dirs
    assert "/x/y" in s.dirs
    assert "/x/y/z" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_p_existing_parent():
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/existing")
    await mkdir_p(a, "/existing/child/grandchild")
    assert "/existing/child" in s.dirs
    assert "/existing/child/grandchild" in s.dirs


@pytest.mark.asyncio
async def test_mkdir_p_does_not_overwrite_modified():
    s = RAMStore()

    a = RAMAccessor(s)
    await mkdir_p(a, "/a")
    original_modified = s.modified["/a"]
    await mkdir_p(a, "/a/b")
    assert s.modified["/a"] == original_modified
