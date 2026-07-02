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
from mirage.core.redis.read import read_bytes
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:read:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    await s.set_file("/hello.txt", b"hello world")
    await s.set_file("/sub/nested.txt", b"nested")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_read_bytes(accessor):
    result = await read_bytes(
        accessor,
        PathSpec(resource_path=("/hello.txt").strip("/"),
                 virtual="/hello.txt",
                 directory="/hello.txt"))
    assert result == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_nested(accessor):
    result = await read_bytes(
        accessor,
        PathSpec(resource_path=("/sub/nested.txt").strip("/"),
                 virtual="/sub/nested.txt",
                 directory="/sub/nested.txt"))
    assert result == b"nested"


@pytest.mark.asyncio
async def test_read_bytes_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read_bytes(
            accessor,
            PathSpec(resource_path=("/nope.txt").strip("/"),
                     virtual="/nope.txt",
                     directory="/nope.txt"))


@pytest.mark.asyncio
async def test_read_bytes_empty_file():
    s = RedisStore(url=REDIS_URL, key_prefix="test:read:e:")
    await s.clear()
    await s.set_file("/empty", b"")
    a = RedisAccessor(s)
    result = await read_bytes(
        a,
        PathSpec(resource_path=("/empty").strip("/"),
                 virtual="/empty",
                 directory="/empty"))
    assert result == b""
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_read_bytes_binary_data():
    s = RedisStore(url=REDIS_URL, key_prefix="test:read:b:")
    await s.clear()
    data = bytes(range(256))
    await s.set_file("/bin", data)
    a = RedisAccessor(s)
    result = await read_bytes(
        a,
        PathSpec(resource_path=("/bin").strip("/"),
                 virtual="/bin",
                 directory="/bin"))
    assert result == data
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_read_bytes_normalizes_path():
    s = RedisStore(url=REDIS_URL, key_prefix="test:read:n:")
    await s.clear()
    await s.set_file("/file.txt", b"data")
    a = RedisAccessor(s)
    result = await read_bytes(
        a,
        PathSpec(resource_path=("file.txt").strip("/"),
                 virtual="file.txt",
                 directory="file.txt"))
    assert result == b"data"
    await s.clear()
    await s.close()
