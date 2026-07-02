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
from mirage.cache.index import RAMIndexCacheStore
from mirage.core.redis.mkdir import mkdir
from mirage.ops.redis.append import append_bytes
from mirage.ops.redis.create import create
from mirage.ops.redis.mkdir import mkdir as mkdir_op
from mirage.ops.redis.read.read import read
from mirage.ops.redis.readdir import readdir
from mirage.ops.redis.rename import rename
from mirage.ops.redis.rmdir import rmdir
from mirage.ops.redis.stat import stat
from mirage.ops.redis.truncate import truncate
from mirage.ops.redis.unlink import unlink
from mirage.ops.redis.write import write
from mirage.resource.redis.store import RedisStore
from mirage.types import FileType, PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


def _scope(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:ops:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    await s.set_file("/hello.txt", b"hello")
    await s.set_file("/sub/child.txt", b"child")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.fixture
def index():
    return RAMIndexCacheStore(ttl=600)


@pytest.mark.asyncio
async def test_op_read(accessor, index):
    result = await read(accessor, _scope("/hello.txt"), index=index)
    assert result == b"hello"


@pytest.mark.asyncio
async def test_op_read_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _scope("/nope.txt"), index=index)


@pytest.mark.asyncio
async def test_op_write(accessor):
    await write(accessor, _scope("/new.txt"), data=b"new data")
    assert await accessor.store.get_file("/new.txt") == b"new data"


@pytest.mark.asyncio
async def test_op_write_and_read(accessor, index):
    await write(accessor, _scope("/w.txt"), data=b"written")
    result = await read(accessor, _scope("/w.txt"), index=index)
    assert result == b"written"


@pytest.mark.asyncio
async def test_op_stat_file(accessor, index):
    result = await stat(accessor, _scope("/hello.txt"), index=index)
    assert result.name == "hello.txt"
    assert result.size == 5
    assert result.type == FileType.TEXT


@pytest.mark.asyncio
async def test_op_stat_directory(accessor, index):
    result = await stat(accessor, _scope("/sub"), index=index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_op_readdir(accessor, index):
    result = await readdir(accessor, _scope("/"), index=index)
    assert "/hello.txt" in result
    assert "/sub" in result


@pytest.mark.asyncio
async def test_op_create(accessor):
    await create(accessor, _scope("/created.txt"))
    assert await accessor.store.get_file("/created.txt") == b""


@pytest.mark.asyncio
async def test_op_mkdir(accessor):
    await mkdir_op(accessor, _scope("/newdir"))
    assert await accessor.store.has_dir("/newdir")


@pytest.mark.asyncio
async def test_op_unlink(accessor):
    await unlink(accessor, _scope("/hello.txt"))
    assert not await accessor.store.has_file("/hello.txt")


@pytest.mark.asyncio
async def test_op_unlink_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await unlink(accessor, _scope("/missing.txt"))


@pytest.mark.asyncio
async def test_op_rmdir(accessor):
    await mkdir(
        accessor,
        PathSpec(resource_path="empty", virtual="/empty", directory="/empty"))
    await rmdir(accessor, _scope("/empty"))
    assert not await accessor.store.has_dir("/empty")


@pytest.mark.asyncio
async def test_op_rename(accessor):
    src = _scope("/hello.txt")
    dst = _scope("/renamed.txt")
    await rename(accessor, src, dst)
    assert await accessor.store.has_file("/renamed.txt")
    assert not await accessor.store.has_file("/hello.txt")


@pytest.mark.asyncio
async def test_op_append(accessor):
    await append_bytes(accessor, _scope("/hello.txt"), data=b" world")
    assert await accessor.store.get_file("/hello.txt") == b"hello world"


@pytest.mark.asyncio
async def test_op_truncate(accessor):
    await truncate(accessor, _scope("/hello.txt"), length=3)
    assert await accessor.store.get_file("/hello.txt") == b"hel"
