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
from mirage.core.redis.create import create
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


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
async def test_create(mk_store):
    a = await mk_store("test:create:1:")
    await create(a, PathSpec.from_str_path("/new.txt"))
    assert await a.store.get_file("/new.txt") == b""
    assert await a.store.get_modified("/new.txt") is not None


@pytest.mark.asyncio
async def test_create_overwrites_existing(mk_store):
    a = await mk_store("test:create:2:")
    await a.store.set_file("/existing.txt", b"old data")
    await create(a, PathSpec.from_str_path("/existing.txt"))
    assert await a.store.get_file("/existing.txt") == b""


@pytest.mark.asyncio
async def test_create_normalizes_path(mk_store):
    a = await mk_store("test:create:3:")
    await create(a, PathSpec.from_str_path("file.txt"))
    assert await a.store.has_file("/file.txt")
