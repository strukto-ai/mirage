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

from mirage.resource.redis.store import RedisStore

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def store():
    s = RedisStore(url=REDIS_URL, key_prefix="test:store:")
    await s.clear()
    await s.add_dir("/")
    yield s
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_get_set_file(store):
    await store.set_file("/a.txt", b"hello")
    assert await store.get_file("/a.txt") == b"hello"


@pytest.mark.asyncio
async def test_get_file_missing(store):
    assert await store.get_file("/nope") is None


@pytest.mark.asyncio
async def test_del_file(store):
    await store.set_file("/a.txt", b"data")
    await store.del_file("/a.txt")
    assert await store.get_file("/a.txt") is None


@pytest.mark.asyncio
async def test_has_file(store):
    assert await store.has_file("/a.txt") is False
    await store.set_file("/a.txt", b"x")
    assert await store.has_file("/a.txt") is True


@pytest.mark.asyncio
async def test_list_files(store):
    await store.set_file("/a.txt", b"a")
    await store.set_file("/b.txt", b"b")
    await store.set_file("/sub/c.txt", b"c")
    files = await store.list_files()
    assert "/a.txt" in files
    assert "/b.txt" in files
    assert "/sub/c.txt" in files


@pytest.mark.asyncio
async def test_list_files_prefix(store):
    await store.set_file("/a.txt", b"a")
    await store.set_file("/sub/b.txt", b"b")
    files = await store.list_files("/sub/")
    assert "/sub/b.txt" in files
    assert "/a.txt" not in files


@pytest.mark.asyncio
async def test_file_len(store):
    await store.set_file("/a.txt", b"hello")
    assert await store.file_len("/a.txt") == 5


@pytest.mark.asyncio
async def test_has_dir(store):
    assert await store.has_dir("/") is True
    assert await store.has_dir("/sub") is False


@pytest.mark.asyncio
async def test_add_remove_dir(store):
    await store.add_dir("/sub")
    assert await store.has_dir("/sub") is True
    await store.remove_dir("/sub")
    assert await store.has_dir("/sub") is False


@pytest.mark.asyncio
async def test_list_dirs(store):
    await store.add_dir("/a")
    await store.add_dir("/b")
    dirs = await store.list_dirs()
    assert "/" in dirs
    assert "/a" in dirs
    assert "/b" in dirs


@pytest.mark.asyncio
async def test_get_set_modified(store):
    await store.set_modified("/a.txt", "2026-01-01T00:00:00")
    result = await store.get_modified("/a.txt")
    assert result == "2026-01-01T00:00:00"


@pytest.mark.asyncio
async def test_get_modified_missing(store):
    assert await store.get_modified("/nope") is None


@pytest.mark.asyncio
async def test_del_modified(store):
    await store.set_modified("/a.txt", "2026-01-01")
    await store.del_modified("/a.txt")
    assert await store.get_modified("/a.txt") is None


@pytest.mark.asyncio
async def test_clear(store):
    await store.set_file("/a.txt", b"data")
    await store.add_dir("/sub")
    await store.set_modified("/a.txt", "2026-01-01")
    await store.clear()
    assert await store.get_file("/a.txt") is None
    assert await store.has_dir("/sub") is False
    assert await store.get_modified("/a.txt") is None
