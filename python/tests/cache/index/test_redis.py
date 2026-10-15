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

from mirage.cache.index import LookupStatus
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.types import FileStat, FileType

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def store(redis_prefix):
    s = RedisIndexCacheStore(ttl=60, url=REDIS_URL, key_prefix=redis_prefix)
    await s.clear()
    yield s
    await s.clear()
    await s.close()


@pytest_asyncio.fixture()
def entry():
    return FileStat(
        name="Test File",
        type=FileType.FILE,
        modified="2026-04-01T00:00:00.000Z",
        fingerprint="file1",
    )


@pytest.mark.asyncio
async def test_put_and_get(store, entry):
    await store.put("/folder/test_file.txt", entry)
    result = await store.get("/folder/test_file.txt")
    assert result.entry is not None
    assert result.entry.fingerprint == "file1"
    assert result.entry.name == "Test File"


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
        (
            "a.txt",
            FileStat(name="A", type=FileType.FILE, fingerprint="a"),
        ),
        (
            "b.txt",
            FileStat(name="B", type=FileType.FILE, fingerprint="b"),
        ),
    ]
    await store.set_dir("/mydir", entries)
    result = await store.list_dir("/mydir")
    assert result.status is None
    assert sorted(result.entries) == ["/mydir/a.txt", "/mydir/b.txt"]


@pytest.mark.asyncio
async def test_set_dir_root(store):
    entries = [
        (
            "top.txt",
            FileStat(name="T", type=FileType.FILE, fingerprint="t"),
        ),
    ]
    await store.set_dir("/", entries)
    result = await store.list_dir("/")
    assert result.status is None
    assert result.entries == ["/top.txt"]


@pytest.mark.asyncio
async def test_set_dir_entries_are_retrievable(store):
    entries = [
        ("x.csv", FileStat(name="x.csv", type=FileType.FILE, fingerprint="x1"))
    ]
    await store.set_dir("/root", entries)
    result = await store.get("/root/x.csv")
    assert result.entry is not None
    assert result.entry.fingerprint == "x1"


@pytest.mark.asyncio
async def test_list_dir_expired(store):
    entries = [
        (
            "file.txt",
            FileStat(name="F", type=FileType.FILE, fingerprint="f"),
        ),
    ]
    past = datetime.now(timezone.utc) + timedelta(seconds=1)
    await store.set_dir("/dir", entries, expired_at=past)
    time.sleep(1.5)
    result = await store.list_dir("/dir")
    assert result.status == LookupStatus.EXPIRED


@pytest.mark.asyncio
async def test_list_dir_fresh(store):
    entries = [
        (
            "file.txt",
            FileStat(name="F", type=FileType.FILE, fingerprint="f"),
        ),
    ]
    future = datetime.now(timezone.utc) + timedelta(seconds=3600)
    await store.set_dir("/dir", entries, expired_at=future)
    result = await store.list_dir("/dir")
    assert result.status is None
    assert result.entries == ["/dir/file.txt"]


@pytest.mark.asyncio
async def test_set_dir_overwrites_previous(store):
    await store.set_dir(
        "/d",
        [
            (
                "old.txt",
                FileStat(name="old.txt", type=FileType.FILE, fingerprint="o"),
            )
        ],
    )
    await store.set_dir(
        "/d",
        [
            (
                "new.txt",
                FileStat(name="new.txt", type=FileType.FILE, fingerprint="n"),
            )
        ],
    )
    result = await store.list_dir("/d")
    assert result.entries is not None
    assert len(result.entries) == 1
    assert "new.txt" in result.entries[0]


@pytest.mark.asyncio
async def test_invalidate_dir_evicts_child_entries(store, entry):
    await store.set_dir("/folder", [("test.txt", entry)])
    assert (await store.get("/folder/test.txt")).entry is not None
    await store.invalidate_dir("/folder")
    assert (
        await store.get("/folder/test.txt")
    ).status == LookupStatus.NOT_FOUND
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
async def test_key_prefix_isolation(redis_prefix):
    s1 = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=f"{redis_prefix}ns1:"
    )
    s2 = RedisIndexCacheStore(
        ttl=60, url=REDIS_URL, key_prefix=f"{redis_prefix}ns2:"
    )
    await s1.clear()
    await s2.clear()
    await s1.put(
        "/shared", FileStat(name="a", type=FileType.FILE, fingerprint="a")
    )
    assert (await s2.get("/shared")).status == LookupStatus.NOT_FOUND
    assert (await s1.get("/shared")).entry is not None
    await s1.clear()
    await s2.clear()
    await s1.close()
    await s2.close()


@pytest.mark.asyncio
async def test_invalidate_prefix_drops_nested_listings(store, entry):
    await store.set_dir("/chan/day", [("chat.jsonl", entry)])
    await store.set_dir("/chan/day/files", [("a.png", entry)])
    await store.invalidate_prefix("/chan/day")
    assert (await store.list_dir("/chan/day")).entries is None
    assert (await store.list_dir("/chan/day/files")).entries is None
    assert (await store.get("/chan/day/files/a.png")).entry is None


@pytest.mark.asyncio
async def test_invalidate_prefix_respects_path_boundary(store, entry):
    await store.set_dir("/chan/day", [("a", entry)])
    await store.set_dir("/chan/daytime", [("b", entry)])
    await store.invalidate_prefix("/chan/day")
    assert (await store.list_dir("/chan/day")).entries is None
    assert (await store.list_dir("/chan/daytime")).entries is not None


@pytest.mark.asyncio
async def test_invalidate_prefix_handles_glob_metacharacters(store, entry):
    await store.set_dir("/chan/a[1]", [("x", entry)])
    await store.set_dir("/chan/ab", [("y", entry)])
    await store.invalidate_prefix("/chan/a[1]")
    assert (await store.list_dir("/chan/a[1]")).entries is None
    assert (await store.list_dir("/chan/ab")).entries is not None


# The one wire format: what pydantic writes for a FileStat, snake_case and
# every field. `redis.test.ts` pins the same literal, so a row either
# language writes is one the other reads.
ENTRY_WIRE = (
    '{"name":"a.txt","size":6,"modified":"2026-01-01T00:00:00Z",'
    '"fingerprint":"/a.txt","revision":null,"type":"file","content":null,'
    '"mode":null,"uid":null,"gid":null,"atime":null,"ctime":null,'
    '"birthtime":null,"dev":null,"extra":{}}'
)


@pytest.mark.asyncio
async def test_entry_wire_format_is_the_shared_json(store):
    await store.put(
        "/a.txt",
        FileStat(
            name="a.txt",
            type=FileType.FILE,
            size=6,
            modified="2026-01-01T00:00:00Z",
            fingerprint="/a.txt",
        ),
    )
    assert await store._client.get(store._entry_key("/a.txt")) == ENTRY_WIRE
