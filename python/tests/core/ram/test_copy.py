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
from mirage.core.ram.copy import copy
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


def spec(path: str) -> PathSpec:
    return PathSpec(resource_path=path.lstrip("/"),
                    virtual=path,
                    directory=path)


@pytest.fixture
def accessor():
    store = RAMStore()
    store.files["/a.txt"] = b"hi"
    store.files["/plain"] = b"y"
    store.dirs.add("/d")
    return RAMAccessor(store)


@pytest.mark.asyncio
async def test_copy_file(accessor):
    await copy(accessor, spec("/a.txt"), spec("/d/b.txt"))
    assert accessor.store.files["/d/b.txt"] == b"hi"
    assert accessor.store.files["/a.txt"] == b"hi"


@pytest.mark.asyncio
async def test_copy_missing_source(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(accessor, spec("/nope"), spec("/d/x"))


@pytest.mark.asyncio
async def test_copy_into_missing_parent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(accessor, spec("/a.txt"), spec("/missing/a.txt"))
    assert "/missing/a.txt" not in accessor.store.files


@pytest.mark.asyncio
async def test_copy_into_missing_grandparent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(accessor, spec("/a.txt"), spec("/missing/sub/a.txt"))
    assert "/missing/sub/a.txt" not in accessor.store.files


@pytest.mark.asyncio
async def test_copy_under_a_file_is_enotdir(accessor):
    with pytest.raises(NotADirectoryError):
        await copy(accessor, spec("/a.txt"), spec("/plain/c.txt"))
    assert "/plain/c.txt" not in accessor.store.files


@pytest.mark.asyncio
async def test_copy_deep_under_a_file_is_enotdir(accessor):
    with pytest.raises(NotADirectoryError):
        await copy(accessor, spec("/a.txt"), spec("/plain/sub/c.txt"))
    assert "/plain/sub/c.txt" not in accessor.store.files


@pytest.mark.asyncio
async def test_copy_to_root_child_is_allowed(accessor):
    await copy(accessor, spec("/a.txt"), spec("/b.txt"))
    assert accessor.store.files["/b.txt"] == b"hi"
