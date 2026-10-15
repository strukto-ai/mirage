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

from datetime import datetime, timedelta, timezone

import pytest

from mirage.cache.index import (
    IndexCacheStore,
    LookupStatus,
    RAMIndexCacheStore,
)
from mirage.types import FileStat, FileType


@pytest.fixture
def store():
    return RAMIndexCacheStore(ttl=60)


@pytest.fixture
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
async def test_list_dir_expired(store):
    entries = [
        (
            "file.txt",
            FileStat(name="F", type=FileType.FILE, fingerprint="f"),
        ),
    ]
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    await store.set_dir("/dir", entries, expired_at=past)
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
async def test_clear(store, entry):
    await store.put("/folder/test.txt", entry)
    await store.set_dir("/folder", [("test.txt", entry)])

    await store.clear()
    result = await store.get("/folder/test.txt")
    assert result.status == LookupStatus.NOT_FOUND
    result = await store.list_dir("/folder")
    assert result.status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_a_store_that_cannot_tell_answers_that_it_holds_a_subtree():
    # The conservative answer: a caller then drops the whole subtree,
    # which costs a refetch but never serves a removed folder's contents.
    assert await IndexCacheStore().holds_subtree("/a") is True
