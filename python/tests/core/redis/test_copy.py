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
from mirage.core.redis.copy import copy
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


def spec(path: str) -> PathSpec:
    return PathSpec(resource_path=path.lstrip("/"),
                    virtual=path,
                    directory=path)


@pytest_asyncio.fixture()
async def accessor():
    store = RedisStore(url=REDIS_URL, key_prefix="test:copy:")
    await store.clear()
    await store.add_dir("/")
    await store.add_dir("/dir")
    await store.add_dir("/d")
    await store.set_file("/a.txt", b"hi")
    await store.set_file("/plain", b"y")
    await store.set_file("/dir/f", b"x")
    yield RedisAccessor(store)
    await store.clear()
    await store.close()


@pytest.mark.asyncio
async def test_copy_file(accessor):
    await copy(accessor, spec("/a.txt"), spec("/d/b.txt"))
    assert await accessor.store.get_file("/d/b.txt") == b"hi"
    assert await accessor.store.get_file("/a.txt") == b"hi"


@pytest.mark.asyncio
async def test_copy_missing_source(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(accessor, spec("/nope"), spec("/d/x"))


@pytest.mark.asyncio
async def test_copy_into_missing_parent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(accessor, spec("/a.txt"), spec("/missing/a.txt"))
    assert not await accessor.store.has_file("/missing/a.txt")


@pytest.mark.asyncio
async def test_copy_into_missing_grandparent_is_enoent(accessor):
    with pytest.raises(FileNotFoundError):
        await copy(accessor, spec("/a.txt"), spec("/missing/sub/a.txt"))
    assert not await accessor.store.has_file("/missing/sub/a.txt")


@pytest.mark.asyncio
async def test_copy_under_a_file_is_enotdir(accessor):
    with pytest.raises(NotADirectoryError):
        await copy(accessor, spec("/a.txt"), spec("/plain/c.txt"))
    assert not await accessor.store.has_file("/plain/c.txt")


@pytest.mark.asyncio
async def test_copy_deep_under_a_file_is_enotdir(accessor):
    with pytest.raises(NotADirectoryError):
        await copy(accessor, spec("/a.txt"), spec("/plain/sub/c.txt"))
    assert not await accessor.store.has_file("/plain/sub/c.txt")


@pytest.mark.asyncio
async def test_copy_to_root_child_is_allowed(accessor):
    await copy(accessor, spec("/a.txt"), spec("/b.txt"))
    assert await accessor.store.get_file("/b.txt") == b"hi"
