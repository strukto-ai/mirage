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
from mirage.core.redis.stat import stat
from mirage.resource.redis.store import RedisStore
from mirage.types import FileType, PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:stat:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    await s.set_file("/hello.txt", b"hello world")
    await s.set_file("/data.json", b'{"key": "value"}')
    await s.set_file("/img.png", b"\x89PNG")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(accessor,
                        PathSpec(resource_path="", virtual="/", directory="/"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_file(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="hello.txt",
                 virtual="/hello.txt",
                 directory="/hello.txt"))
    assert result.name == "hello.txt"
    assert result.size == 11
    assert result.type == FileType.TEXT


@pytest.mark.asyncio
async def test_stat_directory(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="sub", virtual="/sub", directory="/sub"))
    assert result.type == FileType.DIRECTORY
    assert result.name == "sub"
    assert result.size is None


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(resource_path="nope", virtual="/nope", directory="/nope"))


@pytest.mark.asyncio
async def test_stat_json_file(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="data.json",
                 virtual="/data.json",
                 directory="/data.json"))
    assert result.type == FileType.JSON
    assert result.size == 16


@pytest.mark.asyncio
async def test_stat_image_file(accessor):
    result = await stat(
        accessor,
        PathSpec(resource_path="img.png",
                 virtual="/img.png",
                 directory="/img.png"))
    assert result.type == FileType.IMAGE_PNG
