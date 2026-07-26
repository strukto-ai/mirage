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
from mirage.core.ram.rename import rename
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
    store.dirs.add("/dir")
    store.files["/dir/f"] = b"x"
    store.dirs.add("/d")
    return RAMAccessor(store)


@pytest.mark.asyncio
async def test_rename_file(accessor):
    await rename(accessor, spec("/a.txt"), spec("/d/b.txt"))
    assert accessor.store.files["/d/b.txt"] == b"hi"
    assert "/a.txt" not in accessor.store.files


@pytest.mark.asyncio
async def test_rename_dir_moves_children(accessor):
    await rename(accessor, spec("/dir"), spec("/d/moved"))
    assert "/d/moved" in accessor.store.dirs
    assert accessor.store.files["/d/moved/f"] == b"x"
    assert "/dir/f" not in accessor.store.files


@pytest.mark.asyncio
async def test_rename_missing_source(accessor):
    with pytest.raises(FileNotFoundError):
        await rename(accessor, spec("/nope"), spec("/d/x"))


@pytest.mark.asyncio
async def test_rename_file_into_missing_parent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await rename(accessor, spec("/a.txt"), spec("/missing/a.txt"))
    assert accessor.store.files["/a.txt"] == b"hi"
    assert "/missing/a.txt" not in accessor.store.files


@pytest.mark.asyncio
async def test_rename_dir_into_missing_parent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await rename(accessor, spec("/dir"), spec("/missing/dir"))
    assert "/dir" in accessor.store.dirs
    assert accessor.store.files["/dir/f"] == b"x"
    assert "/missing/dir" not in accessor.store.dirs


@pytest.mark.asyncio
async def test_rename_into_missing_grandparent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await rename(accessor, spec("/a.txt"), spec("/missing/sub/a.txt"))
    assert accessor.store.files["/a.txt"] == b"hi"


@pytest.mark.asyncio
async def test_rename_under_a_file_is_enotdir(accessor):
    with pytest.raises(NotADirectoryError):
        await rename(accessor, spec("/a.txt"), spec("/plain/c.txt"))
    assert accessor.store.files["/a.txt"] == b"hi"
    assert "/plain/c.txt" not in accessor.store.files


@pytest.mark.asyncio
async def test_rename_deep_under_a_file_is_enotdir(accessor):
    with pytest.raises(NotADirectoryError):
        await rename(accessor, spec("/a.txt"), spec("/plain/sub/c.txt"))
    assert accessor.store.files["/a.txt"] == b"hi"


@pytest.mark.asyncio
async def test_rename_resolves_dest_before_source(accessor):
    # rename(2) resolves the destination path first: a bad destination
    # parent outranks a missing source (ENOTDIR, not ENOENT).
    with pytest.raises(NotADirectoryError):
        await rename(accessor, spec("/nope"), spec("/plain/x"))


@pytest.mark.asyncio
async def test_rename_to_root_child_is_allowed(accessor):
    await rename(accessor, spec("/a.txt"), spec("/b.txt"))
    assert accessor.store.files["/b.txt"] == b"hi"
