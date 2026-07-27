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
from mirage.core.ram.create import create
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_create():
    s = RAMStore()

    a = RAMAccessor(s)
    await create(a, PathSpec.from_str_path("/new.txt"))
    assert s.files["/new.txt"] == b""
    assert "/new.txt" in s.modified


@pytest.mark.asyncio
async def test_create_overwrites_existing():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/existing.txt"] = b"old data"
    await create(a, PathSpec.from_str_path("/existing.txt"))
    assert s.files["/existing.txt"] == b""


@pytest.mark.asyncio
async def test_create_normalizes_path():
    s = RAMStore()

    a = RAMAccessor(s)
    await create(a, PathSpec.from_str_path("file.txt"))
    assert "/file.txt" in s.files


@pytest.mark.asyncio
async def test_create_into_missing_parent_leaves_no_orphan():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await create(a, PathSpec.from_str_path("/missing/f.txt"))
    assert "/missing/f.txt" not in s.files


@pytest.mark.asyncio
async def test_create_under_a_missing_grandparent_is_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await create(a, PathSpec.from_str_path("/missing/sub/f.txt"))
    assert "/missing/sub/f.txt" not in s.files


@pytest.mark.asyncio
async def test_create_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await create(a, PathSpec.from_str_path("/plain/f.txt"))
    assert "/plain/f.txt" not in s.files


@pytest.mark.asyncio
async def test_create_deep_under_a_plain_file_is_not_a_directory():
    s = RAMStore()
    s.files["/plain"] = b"x"

    a = RAMAccessor(s)
    with pytest.raises(NotADirectoryError):
        await create(a, PathSpec.from_str_path("/plain/sub/f.txt"))


@pytest.mark.asyncio
async def test_create_into_an_existing_dir_is_allowed():
    s = RAMStore()
    s.dirs.add("/d")

    a = RAMAccessor(s)
    await create(a, PathSpec.from_str_path("/d/f.txt"))
    assert s.files["/d/f.txt"] == b""
