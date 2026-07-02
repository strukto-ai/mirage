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

import os

import pytest
import pytest_asyncio

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.append import append_bytes
from mirage.core.redis.copy import copy
from mirage.core.redis.exists import exists
from mirage.core.redis.rename import rename
from mirage.core.redis.rm import rm_r
from mirage.core.redis.rmdir import rmdir
from mirage.core.redis.truncate import truncate
from mirage.core.redis.unlink import unlink
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:fops:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/dir")
    await s.set_file("/file.txt", b"hello")
    await s.set_file("/dir/child.txt", b"child")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest_asyncio.fixture()
async def mk_store():
    stores = []

    async def _make(prefix):
        s = RedisStore(url=REDIS_URL, key_prefix=prefix)
        await s.clear()
        await s.add_dir("/")
        stores.append(s)
        return RedisAccessor(s)

    yield _make
    for s in stores:
        await s.clear()
        await s.close()


@pytest.mark.asyncio
async def test_copy(accessor):
    await copy(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"),
        PathSpec(resource_path="copy.txt",
                 virtual="/copy.txt",
                 directory="/copy.txt"))
    assert await accessor.store.get_file("/copy.txt") == b"hello"
    assert await accessor.store.get_file("/file.txt") == b"hello"
    assert await accessor.store.get_modified("/copy.txt") is not None


@pytest.mark.asyncio
async def test_copy_not_found(mk_store):
    a = await mk_store("test:fops:cp:")
    with pytest.raises(FileNotFoundError):
        await copy(
            a,
            PathSpec(resource_path="nope.txt",
                     virtual="/nope.txt",
                     directory="/nope.txt"),
            PathSpec(resource_path="dst.txt",
                     virtual="/dst.txt",
                     directory="/dst.txt"))


@pytest.mark.asyncio
async def test_rename_file(accessor):
    await rename(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"),
        PathSpec(resource_path="renamed.txt",
                 virtual="/renamed.txt",
                 directory="/renamed.txt"))
    assert await accessor.store.has_file("/renamed.txt")
    assert not await accessor.store.has_file("/file.txt")
    assert await accessor.store.get_file("/renamed.txt") == b"hello"


@pytest.mark.asyncio
async def test_rename_directory(accessor):
    await rename(
        accessor,
        PathSpec(resource_path="dir", virtual="/dir", directory="/dir"),
        PathSpec(resource_path="newdir",
                 virtual="/newdir",
                 directory="/newdir"))
    assert await accessor.store.has_dir("/newdir")
    assert not await accessor.store.has_dir("/dir")
    assert await accessor.store.has_file("/newdir/child.txt")
    assert not await accessor.store.has_file("/dir/child.txt")


@pytest.mark.asyncio
async def test_rename_not_found(mk_store):
    a = await mk_store("test:fops:rn:")
    with pytest.raises(FileNotFoundError):
        await rename(
            a,
            PathSpec(resource_path="nope", virtual="/nope", directory="/nope"),
            PathSpec(resource_path="dst", virtual="/dst", directory="/dst"))


@pytest.mark.asyncio
async def test_rm_r_file(accessor):
    await rm_r(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"))
    assert not await accessor.store.has_file("/file.txt")


@pytest.mark.asyncio
async def test_rm_r_directory(accessor):
    await rm_r(accessor,
               PathSpec(resource_path="dir", virtual="/dir", directory="/dir"))
    assert not await accessor.store.has_dir("/dir")
    assert not await accessor.store.has_file("/dir/child.txt")


@pytest.mark.asyncio
async def test_rmdir_empty(mk_store):
    a = await mk_store("test:fops:rd:")
    await a.store.add_dir("/empty")
    await rmdir(
        a, PathSpec(resource_path="empty",
                    virtual="/empty",
                    directory="/empty"))
    assert not await a.store.has_dir("/empty")


@pytest.mark.asyncio
async def test_rmdir_not_empty(accessor):
    with pytest.raises(OSError, match="directory not empty"):
        await rmdir(
            accessor,
            PathSpec(resource_path="dir", virtual="/dir", directory="/dir"))


@pytest.mark.asyncio
async def test_rmdir_not_found(mk_store):
    a = await mk_store("test:fops:rd2:")
    with pytest.raises(FileNotFoundError):
        await rmdir(
            a,
            PathSpec(resource_path="nope", virtual="/nope", directory="/nope"))


@pytest.mark.asyncio
async def test_unlink(accessor):
    await unlink(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"))
    assert not await accessor.store.has_file("/file.txt")


@pytest.mark.asyncio
async def test_unlink_not_found(mk_store):
    a = await mk_store("test:fops:ul:")
    with pytest.raises(FileNotFoundError):
        await unlink(
            a,
            PathSpec(resource_path="nope.txt",
                     virtual="/nope.txt",
                     directory="/nope.txt"))


@pytest.mark.asyncio
async def test_truncate_shorter(accessor):
    await truncate(accessor, "/file.txt", 3)
    assert await accessor.store.get_file("/file.txt") == b"hel"


@pytest.mark.asyncio
async def test_truncate_longer(accessor):
    await truncate(accessor, "/file.txt", 8)
    data = await accessor.store.get_file("/file.txt")
    assert data == b"hello\x00\x00\x00"
    assert len(data) == 8


@pytest.mark.asyncio
async def test_truncate_nonexistent(mk_store):
    a = await mk_store("test:fops:tr:")
    await truncate(a, "/new.txt", 5)
    assert await a.store.get_file("/new.txt") == b"\x00\x00\x00\x00\x00"


@pytest.mark.asyncio
async def test_truncate_to_zero(accessor):
    await truncate(accessor, "/file.txt", 0)
    assert await accessor.store.get_file("/file.txt") == b""


@pytest.mark.asyncio
async def test_append_to_existing(accessor):
    await append_bytes(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b" world")
    assert await accessor.store.get_file("/file.txt") == b"hello world"


@pytest.mark.asyncio
async def test_append_to_new(mk_store):
    a = await mk_store("test:fops:ap:")
    await append_bytes(
        a,
        PathSpec(resource_path="new.txt",
                 virtual="/new.txt",
                 directory="/new.txt"), b"data")
    assert await a.store.get_file("/new.txt") == b"data"


@pytest.mark.asyncio
async def test_append_multiple(mk_store):
    a = await mk_store("test:fops:ap2:")
    await append_bytes(
        a, PathSpec(resource_path="f.txt",
                    virtual="/f.txt",
                    directory="/f.txt"), b"a")
    await append_bytes(
        a, PathSpec(resource_path="f.txt",
                    virtual="/f.txt",
                    directory="/f.txt"), b"b")
    await append_bytes(
        a, PathSpec(resource_path="f.txt",
                    virtual="/f.txt",
                    directory="/f.txt"), b"c")
    assert await a.store.get_file("/f.txt") == b"abc"


@pytest.mark.asyncio
async def test_exists_file(accessor):
    assert await exists(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt")) is True


@pytest.mark.asyncio
async def test_exists_dir(accessor):
    assert await exists(
        accessor,
        PathSpec(resource_path="dir", virtual="/dir",
                 directory="/dir")) is True


@pytest.mark.asyncio
async def test_exists_root(accessor):
    assert await exists(accessor,
                        PathSpec(resource_path="", virtual="/",
                                 directory="/")) is True


@pytest.mark.asyncio
async def test_exists_missing(mk_store):
    a = await mk_store("test:fops:ex:")
    assert await exists(
        a, PathSpec(resource_path="nope", virtual="/nope",
                    directory="/nope")) is False
