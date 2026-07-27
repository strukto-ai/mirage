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
from mirage.core.redis.du import entries
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:du:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    await s.set_file("/a.txt", b"hello")
    await s.set_file("/sub/b.txt", b"world!")
    await s.set_file("/sub/c.txt", b"data")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_entries_root(accessor):
    found, total = await entries(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"))
    assert total == 15
    paths = [e[0] for e in found]
    assert "/a.txt" in paths
    assert "/sub/b.txt" in paths
    assert "/sub/c.txt" in paths


@pytest.mark.asyncio
async def test_entries_subdir(accessor):
    found, total = await entries(
        accessor,
        PathSpec(resource_path="sub", virtual="/sub", directory="/sub"))
    assert total == 10
    assert len(found) == 2
