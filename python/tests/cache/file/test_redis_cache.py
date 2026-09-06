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
import os

import pytest
import pytest_asyncio

from mirage.cache.file import io as cache_io
from mirage.cache.file.redis import RedisFileCacheStore
from mirage.io import CachableAsyncIterator, IOResult
from mirage.observe.record import OpRecord

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def cache():
    c = RedisFileCacheStore(
        cache_limit="1MB",
        url=REDIS_URL,
        key_prefix="test:cache:",
    )
    await c.clear()
    yield c
    await c.clear()
    await c.close()


@pytest.mark.asyncio
async def test_set_and_get(cache):
    await cache.set("/file.txt", b"hello")
    result = await cache.get("/file.txt")
    assert result == b"hello"


@pytest.mark.asyncio
async def test_get_missing(cache):
    result = await cache.get("/nope")
    assert result is None


@pytest.mark.asyncio
async def test_remove(cache):
    await cache.set("/file.txt", b"data")
    await cache.remove("/file.txt")
    assert await cache.get("/file.txt") is None


@pytest.mark.asyncio
async def test_exists(cache):
    assert await cache.exists("/file.txt") is False
    await cache.set("/file.txt", b"data")
    assert await cache.exists("/file.txt") is True


@pytest.mark.asyncio
async def test_is_fresh(cache):
    await cache.set("/file.txt", b"data", fingerprint="abc123")
    assert await cache.is_fresh("/file.txt", "abc123") is True
    assert await cache.is_fresh("/file.txt", "different") is False


@pytest.mark.asyncio
async def test_is_fresh_missing(cache):
    assert await cache.is_fresh("/nope", "abc") is False


@pytest.mark.asyncio
async def test_clear(cache):
    await cache.set("/a.txt", b"a")
    await cache.set("/b.txt", b"b")
    await cache.clear()
    assert await cache.get("/a.txt") is None
    assert await cache.get("/b.txt") is None


@pytest.mark.asyncio
async def test_add_new(cache):
    result = await cache.add("/file.txt", b"data")
    assert result is True
    assert await cache.get("/file.txt") == b"data"


@pytest.mark.asyncio
async def test_add_existing(cache):
    await cache.set("/file.txt", b"first")
    result = await cache.add("/file.txt", b"second")
    assert result is False
    assert await cache.get("/file.txt") == b"first"


@pytest.mark.asyncio
async def test_concurrent_add_has_one_winner(cache):
    contenders = [(f"value-{i}".encode(), f"fingerprint-{i}")
                  for i in range(32)]
    inserted = await asyncio.gather(
        *(cache.add("/shared.txt", data, fingerprint=fingerprint)
          for data, fingerprint in contenders))

    assert sum(inserted) == 1
    winner = inserted.index(True)
    data, fingerprint = contenders[winner]
    assert await cache.get("/shared.txt") == data
    assert await cache.is_fresh("/shared.txt", fingerprint) is True


@pytest.mark.asyncio
async def test_add_preserves_binary_data_and_ttl(cache):
    data = b"\x00\xff\x80binary"
    assert await cache.add("/binary.bin", data, fingerprint="binary-fp", ttl=1)
    assert await cache.get("/binary.bin") == data
    assert await cache.is_fresh("/binary.bin", "binary-fp") is True

    await asyncio.sleep(1.1)
    assert await cache.get("/binary.bin") is None
    assert await cache.is_fresh("/binary.bin", "binary-fp") is False


@pytest.mark.asyncio
async def test_set_with_fingerprint(cache):
    await cache.set("/file.txt", b"data", fingerprint="fp1")
    assert await cache.is_fresh("/file.txt", "fp1") is True


@pytest.mark.asyncio
async def test_cache_limit(cache):
    assert cache.cache_limit == 1 * 1024 * 1024


@pytest.mark.asyncio
async def test_key_prefix_isolation():
    c1 = RedisFileCacheStore(url=REDIS_URL, key_prefix="test:cache:ns1:")
    c2 = RedisFileCacheStore(url=REDIS_URL, key_prefix="test:cache:ns2:")
    await c1.clear()
    await c2.clear()
    await c1.set("/shared", b"from-c1")
    assert await c2.get("/shared") is None
    assert await c1.get("/shared") == b"from-c1"
    await c1.clear()
    await c2.clear()
    await c1.close()
    await c2.close()


@pytest.mark.asyncio
async def test_apply_io_drains_stream_into_cache(cache):
    """An unexhausted stream must background-drain into the Redis cache
    like the RAM store does, carrying the record fingerprint."""

    async def _gen():
        yield b"drained"

    stream = CachableAsyncIterator(_gen())
    io = IOResult(reads={"/file.txt": stream}, cache=["/file.txt"])
    records = [
        OpRecord(op="read",
                 path="/file.txt",
                 source="s3",
                 bytes=0,
                 timestamp=0,
                 duration_ms=0,
                 fingerprint="etag-9")
    ]
    await cache_io.apply_io(cache, io, records=records)
    tasks = list(cache._drain_tasks.values())
    assert tasks, "drain task must be registered"
    await asyncio.gather(*tasks)
    assert await cache.get("/file.txt") == b"drained"
    assert await cache.is_fresh("/file.txt", "etag-9") is True


@pytest.mark.asyncio
async def test_remove_cancels_pending_drain(cache):
    started = asyncio.Event()

    async def _gen():
        started.set()
        await asyncio.sleep(1)
        yield b"slow"

    stream = CachableAsyncIterator(_gen())
    io = IOResult(reads={"/slow.txt": stream}, cache=["/slow.txt"])
    await cache_io.apply_io(cache, io)
    assert "/slow.txt" in cache._drain_tasks
    await started.wait()
    await cache.remove("/slow.txt")
    assert "/slow.txt" not in cache._drain_tasks
    await asyncio.sleep(0.05)
    assert await cache.get("/slow.txt") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["set", "add"])
@pytest.mark.parametrize("invalidation", ["clear", "remove", "evict_prefix"])
async def test_fill_invalidated_during_hashing(cache, monkeypatch, method,
                                               invalidation):
    from mirage.cache.file import redis as redis_cache
    from mirage.cache.file.utils import default_fingerprint

    entered = asyncio.Event()
    release = asyncio.Event()

    async def paused_hash(data):
        entered.set()
        await release.wait()
        return default_fingerprint(data)

    monkeypatch.setattr(redis_cache, "default_fingerprint_async", paused_hash)
    pending = asyncio.create_task(getattr(cache, method)("/pending", b"old"))
    try:
        await entered.wait()
        if invalidation == "clear":
            await cache.clear()
        else:
            await getattr(cache, invalidation)("/pending")
    finally:
        release.set()
        await pending
    assert await cache.get("/pending") is None
    assert not await cache.is_fresh("/pending", default_fingerprint(b"old"))
    await cache.set("/pending", b"new")
    assert await cache.get("/pending") == b"new"
