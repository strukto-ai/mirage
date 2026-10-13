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

import asyncio

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.copy import copy
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram.store import RAMStore


def spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=path.lstrip("/"), virtual=path, directory=path)


def dev_store() -> DevStore:
    return DevStore(DevFiles("owner"))


def dev_spec(key: str) -> PathSpec:
    return PathSpec(
        vfs_path=key.lstrip("/"),
        virtual="/dev" + key,
        directory="/dev" + key[: key.rindex("/") + 1],
    )


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


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "from_pipe,to_pipe", [(True, False), (False, True), (True, True)]
)
async def test_copy_through_a_pipe(from_pipe, to_pipe):
    store = dev_store()
    src, dst, consumed = "/src", "/copied", None
    if from_pipe:
        source = DevicePipe(True)
        src = store.files.allocate_input(source)[0][4:]
        await source.pipe.write(b"hello")
        source.pipe.end()
    else:
        store.files[src] = b"hello"
    if to_pipe:
        target = DevicePipe(False)
        dst = store.files.allocate_input(target)[0][4:]
        consumed = asyncio.create_task(materialize(target.pipe.stream()))
    await copy(RAMAccessor(store), dev_spec(src), dev_spec(dst))
    if consumed is None:
        assert store.files[dst] == b"hello"
    else:
        target.pipe.end()
        assert await asyncio.wait_for(consumed, 3) == b"hello"
    if from_pipe:
        assert store.files.pipe_of(src) is source
