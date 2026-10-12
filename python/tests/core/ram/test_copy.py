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
from mirage.types import MountMode, PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from mirage.workspace import Workspace


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
async def test_copy_reads_a_pipe_source_through_its_reader():
    store = dev_store()
    source = DevicePipe(True)
    path, _ = store.files.allocate_input(source)
    await source.pipe.write(b"hello")
    source.pipe.end()
    await copy(RAMAccessor(store), dev_spec(path[4:]), dev_spec("/copied"))
    assert store.files["/copied"] == b"hello"
    assert store.files.pipe_of(path[4:]) is source


@pytest.mark.asyncio
async def test_copy_writes_into_a_pipe_destination():
    store = dev_store()
    store.files["/src"] = b"hello"
    target = DevicePipe(False)
    path, _ = store.files.allocate_input(target)
    consumed = asyncio.create_task(materialize(target.pipe.stream()))
    await copy(RAMAccessor(store), dev_spec("/src"), dev_spec(path[4:]))
    target.pipe.end()
    assert await asyncio.wait_for(consumed, 3) == b"hello"


@pytest.mark.asyncio
async def test_copy_between_two_pipes_streams_through_both():
    store = dev_store()
    source, target = DevicePipe(True), DevicePipe(False)
    src, _ = store.files.allocate_input(source)
    dst, _ = store.files.allocate_input(target)
    await source.pipe.write(b"through")
    source.pipe.end()
    consumed = asyncio.create_task(materialize(target.pipe.stream()))
    await copy(RAMAccessor(store), dev_spec(src[4:]), dev_spec(dst[4:]))
    target.pipe.end()
    assert await asyncio.wait_for(consumed, 3) == b"through"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        ("cp <(printf hello) /dev/copied; cat /dev/copied", "hello"),
        ("printf hello > /dev/src; cp /dev/src >(cat); wait", "hello"),
    ],
)
async def test_cp_through_a_substitution(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, expected, "")
    finally:
        await ws.close()
