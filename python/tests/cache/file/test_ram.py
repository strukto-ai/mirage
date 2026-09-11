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

import asyncio
import time

import pytest

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.utils.clock import ManualClock


@pytest.mark.asyncio
async def test_data_stored_in_store_files():
    cache = RAMFileCacheStore(cache_limit="1MB")
    await cache.set("/f.txt", b"hello")
    assert cache._store.files["/f.txt"] == b"hello"


@pytest.mark.asyncio
async def test_entry_stored_in_entries():
    cache = RAMFileCacheStore(cache_limit="1MB")
    await cache.set("/f.txt", b"hello")
    entry = cache._entries["/f.txt"]
    assert entry.size == 5


@pytest.mark.asyncio
async def test_remove_cleans_store():
    cache = RAMFileCacheStore(cache_limit="1MB")
    await cache.set("/f.txt", b"data")
    assert "/f.txt" in cache._store.files
    await cache.remove("/f.txt")
    assert "/f.txt" not in cache._store.files
    assert "/f.txt" not in cache._entries


@pytest.mark.asyncio
async def test_clear_empties_store():
    cache = RAMFileCacheStore(cache_limit="1MB")
    await cache.set("/a", b"aaa")
    await cache.set("/b", b"bbb")
    await cache.clear()
    assert len(cache._store.files) == 0
    assert len(cache._entries) == 0


@pytest.mark.asyncio
async def test_locks_cleaned_after_remove():
    cache = RAMFileCacheStore(cache_limit="1MB")
    await cache.set("/a", b"data")
    await cache.remove("/a")
    assert "/a" not in cache._key_locks


@pytest.mark.asyncio
async def test_locks_cleaned_after_clear():
    cache = RAMFileCacheStore(cache_limit="1MB")
    await cache.set("/a", b"aaa")
    await cache.set("/b", b"bbb")
    await cache.clear()
    assert len(cache._key_locks) == 0


@pytest.mark.asyncio
async def test_locks_cleaned_after_eviction():
    cache = RAMFileCacheStore(cache_limit=100)
    await cache.set("/a", b"x" * 60)
    await cache.set("/b", b"y" * 60)
    assert "/a" not in cache._key_locks


@pytest.mark.asyncio
async def test_drain_task_cancelled_on_remove():
    cache = RAMFileCacheStore(cache_limit="1MB")

    cancelled = False

    async def slow():
        nonlocal cancelled
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled = True

    task = asyncio.create_task(slow())
    cache._drain_tasks["/a"] = task
    await cache.set("/a", b"data")
    await asyncio.sleep(0)
    await cache.remove("/a")
    await asyncio.sleep(0)
    assert cancelled


@pytest.mark.asyncio
async def test_evict_prefix_drops_only_matching_keys():
    cache = RAMFileCacheStore()
    await cache.set("/data/a.txt", b"a")
    await cache.set("/data/sub/b.txt", b"bb")
    await cache.set("/other/c.txt", b"ccc")
    await cache.evict_prefix("/data/")
    assert await cache.exists("/data/a.txt") is False
    assert await cache.exists("/data/sub/b.txt") is False
    assert await cache.exists("/other/c.txt") is True


@pytest.mark.asyncio
async def test_evict_prefix_reclaims_the_evicted_bytes():
    """Eviction runs through remove(), so the LRU accounting stays
    truthful instead of leaking the dropped entries' sizes."""
    cache = RAMFileCacheStore()
    await cache.set("/data/a.txt", b"12345")
    await cache.set("/other/c.txt", b"xy")
    await cache.evict_prefix("/data/")
    assert cache.cache_size == 2
    assert cache.cache_entries == 1


@pytest.mark.asyncio
async def test_ttl_boundary_is_exact_on_an_injected_clock():
    # The boundary the seam exists for: probed at ttl-1 and at ttl with
    # no sleep, no real time, and nothing patched globally.
    clock = ManualClock(start=1000.0)
    cache = RAMFileCacheStore(cache_limit="1MB", clock=clock)
    await cache.set("/f.txt", b"hello", ttl=10)
    clock.advance(9)
    assert await cache.exists("/f.txt") is True
    assert await cache.get("/f.txt") == b"hello"
    clock.advance(1)
    assert await cache.exists("/f.txt") is False
    assert await cache.get("/f.txt") is None


@pytest.mark.asyncio
async def test_expired_entry_is_dropped_on_read():
    clock = ManualClock(start=0.0)
    cache = RAMFileCacheStore(cache_limit="1MB", clock=clock)
    await cache.set("/f.txt", b"hello", ttl=5)
    clock.advance(5)
    assert await cache.get("/f.txt") is None
    assert cache.cache_size == 0
    assert cache.cache_entries == 0


@pytest.mark.asyncio
async def test_add_replaces_an_entry_the_clock_expired():
    clock = ManualClock(start=0.0)
    cache = RAMFileCacheStore(cache_limit="1MB", clock=clock)
    await cache.set("/f.txt", b"old", ttl=5)
    assert await cache.add("/f.txt", b"new") is False
    clock.advance(5)
    assert await cache.add("/f.txt", b"new") is True
    assert await cache.get("/f.txt") == b"new"


@pytest.mark.asyncio
async def test_cached_at_is_stamped_by_the_injected_clock():
    clock = ManualClock(start=4242.0)
    cache = RAMFileCacheStore(cache_limit="1MB", clock=clock)
    await cache.set("/f.txt", b"hello")
    assert cache._entries["/f.txt"].cached_at == 4242


@pytest.mark.asyncio
async def test_default_store_stamps_from_the_real_clock():
    cache = RAMFileCacheStore(cache_limit="1MB")
    await cache.set("/f.txt", b"hello")
    assert cache._entries["/f.txt"].cached_at == pytest.approx(time.time(),
                                                               abs=5)
