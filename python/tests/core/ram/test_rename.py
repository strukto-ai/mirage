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
import errno

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.cache.context import push_cache_manager
from mirage.core.dev.pipe import DevicePipe
from mirage.core.ram.rename import rename
from mirage.types import MountMode, PathSpec
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from mirage.workspace import Workspace
from tests.core.object_store.conftest import FakeManager


def spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=path.lstrip("/"), virtual=path, directory=path)


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
async def test_rename_onto_its_own_name_leaves_it_as_it_was(accessor):
    await rename(accessor, spec("/a.txt"), spec("/a.txt"))
    await rename(accessor, spec("/dir"), spec("/dir"))
    assert accessor.store.files["/a.txt"] == b"hi"
    assert "/dir" in accessor.store.dirs
    assert accessor.store.files["/dir/f"] == b"x"


@pytest.mark.asyncio
async def test_rename_dir_moves_children(accessor):
    await rename(accessor, spec("/dir"), spec("/d/moved"))
    assert "/d/moved" in accessor.store.dirs
    assert accessor.store.files["/d/moved/f"] == b"x"
    assert "/dir/f" not in accessor.store.files


@pytest.mark.asyncio
async def test_rename_dir_moves_nested_subdirectories(accessor):
    """The subtree, not just the files under it.

    A synthetic-directory store records each subdirectory as an entry of
    its own; leaving them behind implied a phantom source tree, so the old
    name kept appearing in its parent's listing and then stat as missing.
    The one-level fixture above cannot see this, which is how it survived.
    """
    store = accessor.store
    store.dirs.add("/dir/sub")
    store.files["/dir/sub/deep"] = b"z"
    store.modified["/dir/sub/deep"] = "T0"
    await rename(accessor, spec("/dir"), spec("/d/moved"))
    assert "/dir/sub" not in store.dirs
    assert "/d/moved/sub" in store.dirs
    assert store.files["/d/moved/sub/deep"] == b"z"
    assert "/dir/sub/deep" not in store.files
    # mtimes travel with the subtree; GNU mv preserves them.
    assert store.modified["/d/moved/sub/deep"] == "T0"


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


async def _managed(coro) -> FakeManager:
    manager = FakeManager()
    prev = push_cache_manager(manager)
    try:
        await coro
    finally:
        push_cache_manager(prev)
    return manager


@pytest.mark.asyncio
async def test_rename_file_evicts_no_subtree(accessor):
    # A file has nothing beneath it: both ends take the unlink flavor.
    manager = await _managed(
        rename(accessor, spec("/a.txt"), spec("/d/b.txt"))
    )
    assert manager.subtrees == []
    assert manager.unlinks == ["/d/b.txt", "/a.txt"]


@pytest.mark.asyncio
async def test_rename_dir_evicts_both_subtrees(accessor):
    manager = await _managed(rename(accessor, spec("/dir"), spec("/d/moved")))
    assert manager.subtrees == ["/d/moved", "/dir"]
    assert manager.unlinks == []


@pytest.mark.asyncio
@pytest.mark.parametrize("pipe_end", ["source", "destination"])
async def test_rename_at_a_live_descriptor_is_eperm(pipe_end):
    store = DevStore(DevFiles("owner"))
    endpoint = DevicePipe(True)
    path, _ = store.files.allocate_input(endpoint)
    store.files["/plain"] = b"x"
    src, dst = (
        (path[4:], "/moved") if pipe_end == "source" else ("/plain", path[4:])
    )
    with pytest.raises(PermissionError) as caught:
        await rename(RAMAccessor(store), dev_spec(src), dev_spec(dst))
    assert caught.value.errno == errno.EPERM
    assert store.files.pipe_of(path[4:]) is endpoint
    assert store.files["/plain"] == b"x"
    assert "/moved" not in store.files


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        (
            'f() { mv "$1" /dev/x; echo "st=$?"; cat "$1"; }; f <(echo still)',
            "st=1\nstill\n",
        ),
        ('f() { mv "$1" "$2"; echo "st=$?"; }; f <(true) <(true)', "st=1\n"),
    ],
)
async def test_mv_of_a_substitution_leaves_it_readable(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (io.exit_code, await io.stdout_str()) == (0, expected)
    finally:
        await ws.close()
