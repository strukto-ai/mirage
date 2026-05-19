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
from mirage.core.redis.find import find
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:find:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/src")
    await s.add_dir("/src/lib")
    await s.set_file("/readme.md", b"readme")
    await s.set_file("/src/main.py", b"print('hi')")
    await s.set_file("/src/util.py", b"def f(): pass")
    await s.set_file("/src/lib/helper.py", b"helper")
    await s.set_file("/src/lib/data.json", b"{}")
    await s.set_file("/big.bin", b"x" * 1000)
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_find_all(accessor):
    results = await find(accessor, PathSpec(original="/", directory="/"))
    assert "/readme.md" in results
    assert "/src/main.py" in results
    assert "/src/lib/helper.py" in results
    assert "/src/lib/data.json" in results
    assert "/big.bin" in results


@pytest.mark.asyncio
async def test_find_by_name(accessor):
    results = await find(accessor,
                         PathSpec(original="/", directory="/"),
                         name="*.py")
    assert results == [
        "/src/lib/helper.py",
        "/src/main.py",
        "/src/util.py",
    ]


@pytest.mark.asyncio
async def test_find_by_type_file(accessor):
    results = await find(accessor,
                         PathSpec(original="/src", directory="/src"),
                         type="f")
    assert "/src/main.py" in results
    assert "/src/lib" not in results


@pytest.mark.asyncio
async def test_find_by_type_dir(accessor):
    results = await find(accessor,
                         PathSpec(original="/", directory="/"),
                         type="d")
    assert "/src" in results
    assert "/src/lib" in results
    assert "/readme.md" not in results


@pytest.mark.asyncio
async def test_find_maxdepth(accessor):
    results = await find(accessor,
                         PathSpec(original="/", directory="/"),
                         maxdepth=1,
                         type="f")
    assert "/readme.md" in results
    assert "/big.bin" in results
    assert "/src/main.py" not in results
    assert "/src/lib/helper.py" not in results


@pytest.mark.asyncio
async def test_find_mindepth(accessor):
    results = await find(accessor,
                         PathSpec(original="/", directory="/"),
                         mindepth=2,
                         type="f")
    assert "/readme.md" not in results
    assert "/src/main.py" in results
    assert "/src/lib/helper.py" in results


@pytest.mark.asyncio
async def test_find_min_size(accessor):
    results = await find(accessor,
                         PathSpec(original="/", directory="/"),
                         min_size=100,
                         type="f")
    assert results == ["/big.bin"]


@pytest.mark.asyncio
async def test_find_max_size(accessor):
    results = await find(accessor,
                         PathSpec(original="/", directory="/"),
                         max_size=10,
                         type="f")
    assert "/readme.md" in results
    assert "/src/lib/data.json" in results
    assert "/big.bin" not in results


@pytest.mark.asyncio
async def test_find_name_exclude(accessor):
    results = await find(accessor,
                         PathSpec(original="/src", directory="/src"),
                         name="*.py",
                         name_exclude="util*")
    assert "/src/util.py" not in results
    assert "/src/main.py" in results


@pytest.mark.asyncio
async def test_find_or_names(accessor):
    results = await find(accessor,
                         PathSpec(original="/", directory="/"),
                         or_names=["*.py", "*.json"])
    assert "/src/main.py" in results
    assert "/src/lib/data.json" in results
    assert "/readme.md" not in results


@pytest.mark.asyncio
async def test_find_subdir(accessor):
    results = await find(accessor,
                         PathSpec(original="/src/lib", directory="/src/lib"),
                         type="f")
    assert results == [
        "/src/lib/data.json",
        "/src/lib/helper.py",
    ]


@pytest.mark.asyncio
async def test_find_empty_result():
    s = RedisStore(url=REDIS_URL, key_prefix="test:find:e:")
    await s.clear()
    await s.add_dir("/")
    a = RedisAccessor(s)
    results = await find(a,
                         PathSpec(original="/", directory="/"),
                         name="*.xyz")
    assert results == []
    await s.clear()
    await s.close()
