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

from datetime import datetime

import pytest

from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.cache.index.config import LookupStatus


@pytest.fixture
def store():
    return RAMIndexCacheStore(ttl=60)


@pytest.mark.asyncio
async def test_entries_stored_in_dict(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.put("/f.txt", entry)
    assert "/f.txt" in store._entries


@pytest.mark.asyncio
async def test_children_stored_in_dict(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.set_dir("/dir", [("f.txt", entry)])
    assert "/dir" in store._children
    assert store._children["/dir"] == ["/dir/f.txt"]


@pytest.mark.asyncio
async def test_expiry_stored_in_dict(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.set_dir("/dir", [("f.txt", entry)])
    assert "/dir" in store._expiry
    assert isinstance(store._expiry["/dir"], datetime)


@pytest.mark.asyncio
async def test_invalidate_dir_evicts_child_entries(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.set_dir("/dir", [("f.txt", entry)])
    assert (await store.get("/dir/f.txt")).entry is not None
    await store.invalidate_dir("/dir")
    assert (await store.get("/dir/f.txt")).entry is None
    assert "/dir" not in store._children
    assert "/dir" not in store._expiry


# The distinction the whole github invalidation rests on: `clear` leaves a
# store that reads exactly like one that was never filled, so a backend
# whose index *is* its listing reports an empty repository. `invalidate`
# keeps the rows and only expires them, so the lookup says EXPIRED and the
# backend knows to refetch.
@pytest.mark.asyncio
async def test_invalidate_expires_without_discarding(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.set_dir("/dir", [("f.txt", entry)])
    await store.invalidate()
    assert (await store.list_dir("/dir")).status == LookupStatus.EXPIRED
    assert store._children["/dir"] == ["/dir/f.txt"]
    await store.clear()
    assert (await store.list_dir("/dir")).status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_invalidate_expires_every_directory(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.set_dir("/a", [("f.txt", entry)])
    await store.set_dir("/b", [("g.txt", entry)])
    await store.invalidate()
    assert (await store.list_dir("/a")).status == LookupStatus.EXPIRED
    assert (await store.list_dir("/b")).status == LookupStatus.EXPIRED


# An empty store has nothing to expire, and must not grow a row that makes
# a never-listed directory answer EXPIRED instead of NOT_FOUND.
@pytest.mark.asyncio
async def test_invalidate_leaves_an_unlisted_directory_absent(store):
    await store.invalidate()
    assert (await store.list_dir("/dir")).status == LookupStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_clear_empties_all_dicts(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.put("/f.txt", entry)
    await store.set_dir("/dir", [("f.txt", entry)])
    await store.clear()
    assert len(store._entries) == 0
    assert len(store._children) == 0
    assert len(store._expiry) == 0


@pytest.mark.asyncio
async def test_locks_cleaned_after_clear(store):
    entry = IndexEntry(id="1", name="f", resource_type="file")
    await store.put("/a", entry)
    await store.put("/b", entry)
    await store.clear()
    assert len(store._key_locks) == 0
