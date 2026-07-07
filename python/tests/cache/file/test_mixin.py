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
from unittest.mock import patch

import pytest

from mirage.cache.file.ram import RAMFileCacheStore


class TestGetSet:

    @pytest.mark.asyncio
    async def test_set_and_get(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"hello")
        result = await cache.get("/a")
        assert result == b"hello"

    @pytest.mark.asyncio
    async def test_get_miss(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        assert await cache.get("/missing") is None

    @pytest.mark.asyncio
    async def test_set_overwrites(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"first")
        await cache.set("/a", b"second")
        assert await cache.get("/a") == b"second"

    @pytest.mark.asyncio
    async def test_default_fingerprint(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"data")
        entry = cache._entries.get("/a")
        assert entry is not None
        assert entry.fingerprint is not None

    @pytest.mark.asyncio
    async def test_explicit_fingerprint(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"data", fingerprint="etag-123")
        entry = cache._entries["/a"]
        assert entry.fingerprint == "etag-123"


class TestAdd:

    @pytest.mark.asyncio
    async def test_add_new_key(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        result = await cache.add("/a", b"data")
        assert result is True
        assert await cache.get("/a") == b"data"

    @pytest.mark.asyncio
    async def test_add_existing_key(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"first")
        result = await cache.add("/a", b"second")
        assert result is False
        assert await cache.get("/a") == b"first"


class TestMulti:

    @pytest.mark.asyncio
    async def test_multi_get(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"aaa")
        await cache.set("/b", b"bbb")
        results = await cache.multi_get(["/a", "/missing", "/b"])
        assert results[0] == b"aaa"
        assert results[1] is None
        assert results[2] == b"bbb"

    @pytest.mark.asyncio
    async def test_multi_set(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.multi_set([("/a", b"aaa"), ("/b", b"bbb")])
        assert await cache.get("/a") == b"aaa"
        assert await cache.get("/b") == b"bbb"


class TestExistsRemoveClear:

    @pytest.mark.asyncio
    async def test_exists(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        assert await cache.exists("/a") is False
        await cache.set("/a", b"data")
        assert await cache.exists("/a") is True

    @pytest.mark.asyncio
    async def test_remove(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"data")
        await cache.remove("/a")
        assert await cache.get("/a") is None

    @pytest.mark.asyncio
    async def test_remove_missing(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.remove("/missing")

    @pytest.mark.asyncio
    async def test_remove_cancels_drain_task(self):
        cache = RAMFileCacheStore(cache_limit="1MB")

        cancelled = False

        async def slow_drain():
            nonlocal cancelled
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                cancelled = True

        task = asyncio.create_task(slow_drain())
        cache._drain_tasks["/a"] = task
        await cache.set("/a", b"data")
        await asyncio.sleep(0)
        await cache.remove("/a")
        await asyncio.sleep(0)
        assert cancelled
        assert "/a" not in cache._drain_tasks

    @pytest.mark.asyncio
    async def test_clear(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"aaa")
        await cache.set("/b", b"bbb")
        await cache.clear()
        assert await cache.get("/a") is None
        assert await cache.get("/b") is None
        assert cache.cache_size == 0

    @pytest.mark.asyncio
    async def test_clear_concurrent_with_set(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"aaa")

        async def do_clear():
            await cache.clear()

        async def do_set():
            await cache.set("/b", b"bbb")

        await asyncio.gather(do_clear(), do_set())
        actual_size = sum(e.size for e in cache._entries.values())
        assert cache._cache_size == actual_size


class TestTTL:

    @pytest.mark.asyncio
    async def test_ttl_not_expired(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"data", ttl=60)
        assert await cache.get("/a") == b"data"

    @pytest.mark.asyncio
    async def test_ttl_expired(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        with patch("mirage.cache.file.entry.time.time", return_value=1000.0):
            await cache.set("/a", b"data", ttl=10)
        with patch("mirage.cache.file.entry.time.time", return_value=1011.0):
            result = await cache.get("/a")
        assert result is None

    @pytest.mark.asyncio
    async def test_no_ttl_never_expires(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"data")
        entry = cache._entries["/a"]
        assert entry.ttl is None
        assert entry.expired is False


class TestFingerprint:

    @pytest.mark.asyncio
    async def test_is_fresh_match(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"data", fingerprint="etag-1")
        assert await cache.is_fresh("/a", "etag-1") is True

    @pytest.mark.asyncio
    async def test_is_fresh_mismatch(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"data", fingerprint="etag-1")
        assert await cache.is_fresh("/a", "etag-2") is False

    @pytest.mark.asyncio
    async def test_is_fresh_missing(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        assert await cache.is_fresh("/missing", "etag-1") is False


class TestDrainBudget:

    def test_defaults_to_cache_limit(self):
        cache = RAMFileCacheStore(cache_limit="1KB")
        assert cache.max_drain_bytes is None
        assert cache.drain_budget == 1024

    def test_below_limit_kept(self):
        cache = RAMFileCacheStore(cache_limit="1KB", max_drain_bytes=100)
        assert cache.drain_budget == 100

    def test_above_limit_clamped(self):
        cache = RAMFileCacheStore(cache_limit="1KB", max_drain_bytes=4096)
        assert cache.drain_budget == 1024


class TestEviction:

    @pytest.mark.asyncio
    async def test_lru_evicts_oldest(self):
        cache = RAMFileCacheStore(cache_limit=100)
        await cache.set("/a", b"x" * 60)
        await cache.set("/b", b"y" * 60)
        assert await cache.get("/a") is None
        assert await cache.get("/b") == b"y" * 60

    @pytest.mark.asyncio
    async def test_lru_access_refreshes(self):
        cache = RAMFileCacheStore(cache_limit=150)
        await cache.set("/a", b"x" * 50)
        await cache.set("/b", b"y" * 50)
        await cache.get("/a")
        await cache.set("/c", b"z" * 60)
        assert await cache.get("/a") is not None
        assert await cache.get("/b") is None

    @pytest.mark.asyncio
    async def test_cache_size_tracking(self):
        cache = RAMFileCacheStore(cache_limit="1MB")
        await cache.set("/a", b"x" * 100)
        assert cache.cache_size == 100
        await cache.set("/b", b"y" * 200)
        assert cache.cache_size == 300
        await cache.remove("/a")
        assert cache.cache_size == 200

    @pytest.mark.asyncio
    async def test_cache_limit(self):
        cache = RAMFileCacheStore(cache_limit="1KB")
        assert cache.cache_limit == 1024

    @pytest.mark.asyncio
    async def test_eviction_does_not_corrupt_size(self):
        cache = RAMFileCacheStore(cache_limit=100)
        await cache.set("/a", b"x" * 60)

        async def concurrent_set():
            await cache.set("/a", b"z" * 40)

        async def trigger_eviction():
            await cache.set("/b", b"y" * 60)

        await asyncio.gather(concurrent_set(), trigger_eviction())
        actual_size = sum(e.size for e in cache._entries.values())
        assert cache._cache_size == actual_size
