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
from mirage.core.redis.readdir import readdir
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:readdir:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    await s.add_dir("/sub/deep")
    await s.set_file("/a.txt", b"a")
    await s.set_file("/b.txt", b"b")
    await s.set_file("/sub/c.txt", b"c")
    await s.set_file("/sub/d.txt", b"d")
    await s.set_file("/sub/deep/e.txt", b"e")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.fixture
def index():
    return RAMIndexCacheStore(ttl=600)


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    entries = await readdir(
        accessor,
        PathSpec(resource_path=("/").strip("/"), virtual="/", directory="/"),
        index)
    assert "/a.txt" in entries
    assert "/b.txt" in entries
    assert "/sub" in entries
    assert len(entries) == 3


@pytest.mark.asyncio
async def test_readdir_subdir(accessor, index):
    entries = await readdir(
        accessor,
        PathSpec(resource_path=("/sub").strip("/"),
                 virtual="/sub",
                 directory="/sub"), index)
    assert "/sub/c.txt" in entries
    assert "/sub/d.txt" in entries
    assert "/sub/deep" in entries
    assert len(entries) == 3


@pytest.mark.asyncio
async def test_readdir_empty_dir(index):
    s = RedisStore(url=REDIS_URL, key_prefix="test:readdir:e:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/empty")
    a = RedisAccessor(s)
    entries = await readdir(
        a,
        PathSpec(resource_path=("/empty").strip("/"),
                 virtual="/empty",
                 directory="/empty"), index)
    assert entries == []
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_readdir_not_found(index):
    s = RedisStore(url=REDIS_URL, key_prefix="test:readdir:n:")
    await s.clear()
    await s.add_dir("/")
    a = RedisAccessor(s)
    with pytest.raises(FileNotFoundError):
        await readdir(
            a,
            PathSpec(resource_path=("/nonexistent").strip("/"),
                     virtual="/nonexistent",
                     directory="/nonexistent"), index)
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_readdir_deep(accessor, index):
    entries = await readdir(
        accessor,
        PathSpec(resource_path=("/sub/deep").strip("/"),
                 virtual="/sub/deep",
                 directory="/sub/deep"), index)
    assert "/sub/deep/e.txt" in entries
    assert len(entries) == 1
