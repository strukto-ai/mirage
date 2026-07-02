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
from mirage.core.ram.append import append_bytes
from mirage.core.ram.copy import copy
from mirage.core.ram.exists import exists
from mirage.core.ram.rename import rename
from mirage.core.ram.rm import rm_r
from mirage.core.ram.rmdir import rmdir
from mirage.core.ram.truncate import truncate
from mirage.core.ram.unlink import unlink
from mirage.resource.ram.store import RAMStore
from mirage.types import PathSpec


@pytest.fixture
def store():
    s = RAMStore()

    a = RAMAccessor(s)
    s.files["/file.txt"] = b"hello"
    s.dirs.add("/dir")
    s.files["/dir/child.txt"] = b"child"
    return a


@pytest.mark.asyncio
async def test_copy(store):
    await copy(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"),
        PathSpec(resource_path=("/copy.txt").strip("/"),
                 virtual="/copy.txt",
                 directory="/copy.txt"))
    assert store.store.files["/copy.txt"] == b"hello"
    assert store.store.files["/file.txt"] == b"hello"
    assert "/copy.txt" in store.store.modified


@pytest.mark.asyncio
async def test_copy_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await copy(
            a,
            PathSpec(resource_path=("/nope.txt").strip("/"),
                     virtual="/nope.txt",
                     directory="/nope.txt"),
            PathSpec(resource_path=("/dst.txt").strip("/"),
                     virtual="/dst.txt",
                     directory="/dst.txt"))


@pytest.mark.asyncio
async def test_rename_file(store):
    await rename(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"),
        PathSpec(resource_path=("/renamed.txt").strip("/"),
                 virtual="/renamed.txt",
                 directory="/renamed.txt"))
    assert "/renamed.txt" in store.store.files
    assert "/file.txt" not in store.store.files
    assert store.store.files["/renamed.txt"] == b"hello"


@pytest.mark.asyncio
async def test_rename_directory(store):
    await rename(
        store,
        PathSpec(resource_path=("/dir").strip("/"),
                 virtual="/dir",
                 directory="/dir"),
        PathSpec(resource_path=("/newdir").strip("/"),
                 virtual="/newdir",
                 directory="/newdir"))
    assert "/newdir" in store.store.dirs
    assert "/dir" not in store.store.dirs
    assert "/newdir/child.txt" in store.store.files
    assert "/dir/child.txt" not in store.store.files


@pytest.mark.asyncio
async def test_rename_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await rename(
            a,
            PathSpec(resource_path=("/nope").strip("/"),
                     virtual="/nope",
                     directory="/nope"),
            PathSpec(resource_path=("/dst").strip("/"),
                     virtual="/dst",
                     directory="/dst"))


@pytest.mark.asyncio
async def test_rm_r_file(store):
    await rm_r(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"))
    assert "/file.txt" not in store.store.files


@pytest.mark.asyncio
async def test_rm_r_directory(store):
    await rm_r(
        store,
        PathSpec(resource_path=("/dir").strip("/"),
                 virtual="/dir",
                 directory="/dir"))
    assert "/dir" not in store.store.dirs
    assert "/dir/child.txt" not in store.store.files


@pytest.mark.asyncio
async def test_rmdir_empty():
    s = RAMStore()

    a = RAMAccessor(s)
    s.dirs.add("/empty")
    await rmdir(
        a,
        PathSpec(resource_path=("/empty").strip("/"),
                 virtual="/empty",
                 directory="/empty"))
    assert "/empty" not in s.dirs


@pytest.mark.asyncio
async def test_rmdir_not_empty(store):
    with pytest.raises(OSError, match="directory not empty"):
        await rmdir(
            store,
            PathSpec(resource_path=("/dir").strip("/"),
                     virtual="/dir",
                     directory="/dir"))


@pytest.mark.asyncio
async def test_rmdir_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await rmdir(
            a,
            PathSpec(resource_path=("/nope").strip("/"),
                     virtual="/nope",
                     directory="/nope"))


@pytest.mark.asyncio
async def test_unlink(store):
    await unlink(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"))
    assert "/file.txt" not in store.store.files


@pytest.mark.asyncio
async def test_unlink_not_found():
    s = RAMStore()

    a = RAMAccessor(s)
    with pytest.raises(FileNotFoundError):
        await unlink(
            a,
            PathSpec(resource_path=("/nope.txt").strip("/"),
                     virtual="/nope.txt",
                     directory="/nope.txt"))


@pytest.mark.asyncio
async def test_truncate_shorter(store):
    await truncate(store, "/file.txt", 3)
    assert store.store.files["/file.txt"] == b"hel"


@pytest.mark.asyncio
async def test_truncate_longer(store):
    await truncate(store, "/file.txt", 8)
    assert store.store.files["/file.txt"] == b"hello\x00\x00\x00"
    assert len(store.store.files["/file.txt"]) == 8


@pytest.mark.asyncio
async def test_truncate_nonexistent():
    s = RAMStore()

    a = RAMAccessor(s)
    await truncate(a, "/new.txt", 5)
    assert s.files["/new.txt"] == b"\x00\x00\x00\x00\x00"


@pytest.mark.asyncio
async def test_truncate_to_zero(store):
    await truncate(store, "/file.txt", 0)
    assert store.store.files["/file.txt"] == b""


@pytest.mark.asyncio
async def test_append_to_existing(store):
    await append_bytes(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt"), b" world")
    assert store.store.files["/file.txt"] == b"hello world"


@pytest.mark.asyncio
async def test_append_to_new():
    s = RAMStore()

    a = RAMAccessor(s)
    await append_bytes(
        a,
        PathSpec(resource_path=("/new.txt").strip("/"),
                 virtual="/new.txt",
                 directory="/new.txt"), b"data")
    assert s.files["/new.txt"] == b"data"


@pytest.mark.asyncio
async def test_append_multiple():
    s = RAMStore()

    a = RAMAccessor(s)
    await append_bytes(
        a,
        PathSpec(resource_path=("/f.txt").strip("/"),
                 virtual="/f.txt",
                 directory="/f.txt"), b"a")
    await append_bytes(
        a,
        PathSpec(resource_path=("/f.txt").strip("/"),
                 virtual="/f.txt",
                 directory="/f.txt"), b"b")
    await append_bytes(
        a,
        PathSpec(resource_path=("/f.txt").strip("/"),
                 virtual="/f.txt",
                 directory="/f.txt"), b"c")
    assert s.files["/f.txt"] == b"abc"


@pytest.mark.asyncio
async def test_exists_file(store):
    assert await exists(
        store,
        PathSpec(resource_path=("/file.txt").strip("/"),
                 virtual="/file.txt",
                 directory="/file.txt")) is True


@pytest.mark.asyncio
async def test_exists_dir(store):
    assert await exists(
        store,
        PathSpec(resource_path=("/dir").strip("/"),
                 virtual="/dir",
                 directory="/dir")) is True


@pytest.mark.asyncio
async def test_exists_root():
    s = RAMStore()

    a = RAMAccessor(s)
    assert await exists(
        a, PathSpec(resource_path=("/").strip("/"), virtual="/",
                    directory="/")) is True


@pytest.mark.asyncio
async def test_exists_missing():
    s = RAMStore()

    a = RAMAccessor(s)
    assert await exists(
        a,
        PathSpec(resource_path=("/nope").strip("/"),
                 virtual="/nope",
                 directory="/nope")) is False
