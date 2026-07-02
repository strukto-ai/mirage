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
import time
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio

from mirage.cache.index import IndexEntry, LookupStatus
from mirage.cache.index.redis import RedisIndexCacheStore

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def store():
    s = RedisIndexCacheStore(ttl=60, url=REDIS_URL, key_prefix="test:")
    await s.clear()
    yield s
    await s.clear()
    await s.close()


@pytest_asyncio.fixture()
def entry():
    return IndexEntry(
        id="file1",
        name="Test File",
        resource_type="text/plain",
        remote_time="2026-04-01T00:00:00.000Z",
        vfs_name="test_file.txt",
    )


@pytest.mark.asyncio
async def test_put_and_get(store, entry):
    await store.put("/folder/test_file.txt", entry)
    result = await store.get("/folder/test_file.txt")
    assert result.entry is not None
    assert result.entry.id == "file1"
    assert result.entry.name == "Test File"


@pytest.mark.asyncio
async def test_put_sets_index_time(store, entry):
    await store.put("/folder/test_file.txt", entry)
    result = await store.get("/folder/test_file.txt")
    assert result.entry is not None
    assert result.entry.index_time != ""


@pytest.mark.asyncio
async def test_put_preserves_existing_index_time(store):
    entry = IndexEntry(id="b",
                       name="b.txt",
                       resource_type="file",
                       index_time="2026-01-01T00:00:00")
    await store.put("/data/b.txt", entry)
    result = await store.get("/data/b.txt")
    assert result.entry.index_time == "2026-01-01T00:00:00"


@pytest.mark.asyncio
async def test_get_not_found(store):
    result = await store.get("/nonexistent/file.txt")
    assert result.status == LookupStatus.NOT_FOUND
    assert result.entry is None


@pytest.mark.asyncio
async def test_list_dir_not_found(store):
    result = await store.list_dir("/some_dir")
    assert result.status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_set_dir_and_list(store):
    entries = [
        ("a.txt",
         IndexEntry(id="a",
                    name="A",
                    resource_type="text/plain",
                    vfs_name="a.txt")),
        ("b.txt",
         IndexEntry(id="b",
                    name="B",
                    resource_type="text/plain",
                    vfs_name="b.txt")),
    ]
    await store.set_dir("/mydir", entries)
    result = await store.list_dir("/mydir")
    assert result.status is None
    assert sorted(result.entries) == ["/mydir/a.txt", "/mydir/b.txt"]


@pytest.mark.asyncio
async def test_set_dir_root(store):
    entries = [
        ("top.txt",
         IndexEntry(id="t",
                    name="T",
                    resource_type="text/plain",
                    vfs_name="top.txt")),
    ]
    await store.set_dir("/", entries)
    result = await store.list_dir("/")
    assert result.status is None
    assert result.entries == ["/top.txt"]


@pytest.mark.asyncio
async def test_set_dir_entries_are_retrievable(store):
    entries = [("x.csv", IndexEntry(id="x1",
                                    name="x.csv",
                                    resource_type="file"))]
    await store.set_dir("/root", entries)
    result = await store.get("/root/x.csv")
    assert result.entry is not None
    assert result.entry.id == "x1"


@pytest.mark.asyncio
async def test_list_dir_expired(store):
    entries = [
        ("file.txt",
         IndexEntry(id="f",
                    name="F",
                    resource_type="text/plain",
                    vfs_name="file.txt")),
    ]
    past = datetime.now(timezone.utc) + timedelta(seconds=1)
    await store.set_dir("/dir", entries, expired_at=past)
    time.sleep(1.5)
    result = await store.list_dir("/dir")
    assert result.status in (LookupStatus.NOT_FOUND, LookupStatus.EXPIRED)


@pytest.mark.asyncio
async def test_list_dir_fresh(store):
    entries = [
        ("file.txt",
         IndexEntry(id="f",
                    name="F",
                    resource_type="text/plain",
                    vfs_name="file.txt")),
    ]
    future = datetime.now(timezone.utc) + timedelta(seconds=3600)
    await store.set_dir("/dir", entries, expired_at=future)
    result = await store.list_dir("/dir")
    assert result.status is None
    assert result.entries == ["/dir/file.txt"]


@pytest.mark.asyncio
async def test_set_dir_overwrites_previous(store):
    await store.set_dir("/d", [
        ("old.txt", IndexEntry(id="o", name="old.txt", resource_type="file"))
    ])
    await store.set_dir("/d", [
        ("new.txt", IndexEntry(id="n", name="new.txt", resource_type="file"))
    ])
    result = await store.list_dir("/d")
    assert result.entries is not None
    assert len(result.entries) == 1
    assert "new.txt" in result.entries[0]


@pytest.mark.asyncio
async def test_invalidate_dir_evicts_child_entries(store, entry):
    await store.set_dir("/folder", [("test.txt", entry)])
    assert (await store.get("/folder/test.txt")).entry is not None
    await store.invalidate_dir("/folder")
    assert (await
            store.get("/folder/test.txt")).status == LookupStatus.NOT_FOUND
    assert (await store.list_dir("/folder")).status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_clear(store, entry):
    await store.put("/folder/test.txt", entry)
    await store.set_dir("/folder", [("test.txt", entry)])
    await store.clear()
    result = await store.get("/folder/test.txt")
    assert result.status == LookupStatus.NOT_FOUND
    result = await store.list_dir("/folder")
    assert result.status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_key_prefix_isolation():
    s1 = RedisIndexCacheStore(ttl=60, url=REDIS_URL, key_prefix="ns1:")
    s2 = RedisIndexCacheStore(ttl=60, url=REDIS_URL, key_prefix="ns2:")
    await s1.clear()
    await s2.clear()
    await s1.put("/shared", IndexEntry(id="a", name="a", resource_type="file"))
    assert (await s2.get("/shared")).status == LookupStatus.NOT_FOUND
    assert (await s1.get("/shared")).entry is not None
    await s1.clear()
    await s2.clear()
    await s1.close()
    await s2.close()
