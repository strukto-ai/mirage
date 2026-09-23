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
import pathlib

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
async def test_is_unbounded_distinguishes_absent_from_boundless(cache):
    """Redis answers this as a ttl probe, so the two sentinels matter.

    ``-1`` is present with no expiry and ``-2`` is absent; reading one as
    the other makes every warm bounded read either drop and refetch its
    entry forever, or never self-heal a bound-less one. The RAM store's
    twin cannot catch it: only redis encodes the answer this way.
    """
    assert await cache.is_unbounded("/absent") is False
    await cache.set("/no-bound", b"x")
    assert await cache.is_unbounded("/no-bound") is True
    await cache.set("/bounded", b"x", ttl=30)
    assert await cache.is_unbounded("/bounded") is False


@pytest.mark.asyncio
async def test_a_bound_set_on_redis_actually_expires_the_key(cache):
    # The stamp has to reach redis itself, not just the client's view:
    # a `set` that dropped the ttl would leave `is_unbounded` answering
    # off a key redis never expires.
    await cache.set("/bounded.txt", b"x", ttl=30)
    remaining = await cache._cache_client.ttl(cache._data_key("/bounded.txt"))
    assert 0 < remaining <= 30


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


# The invalidation guard is exercised in `tests/cache/file/test_ram.py`:
# on this store no await remains between `_invalidation.enter` and
# `_invalidation.stale`, so a writer cannot be parked here at all. It
# stays as the shared cross-language contract (TypeScript's redis store
# awaits its client first, so the window is live there).


@pytest.mark.asyncio
async def test_a_token_bearing_set_bounds_its_meta_key_too(cache):
    # The other side of the branch the tokenless case added: when there IS
    # a token the meta key still has to take the ttl. Leaving it immortal
    # lets it outlive the data key redis expires, and the next is_fresh
    # then matches a token describing bytes that are gone -- the same
    # false positive the tokenless delete exists to prevent, one branch
    # over.
    await cache.set("/a", b"data", fingerprint="etag-1", ttl=100)
    assert await cache._cache_client.ttl(cache._meta_key("/a")) > 0
    assert await cache._cache_client.ttl(cache._data_key("/a")) > 0


@pytest.mark.asyncio
async def test_a_tokenless_add_still_bounds_its_data_key(cache):
    # add.lua nests the meta EXPIRE inside the data EXPIRE, so a mistake
    # in that nesting takes the data key's bound with it. This is the
    # combination the background drain now reaches: it calls `add` with
    # whatever `latest_fingerprint` returned -- which may be None -- and
    # the mount's bound. An immortal tokenless entry is the one thing
    # `bounded` can never expire.
    assert await cache.add("/a", b"data", ttl=100)
    assert await cache._cache_client.ttl(cache._data_key("/a")) > 0
    assert not await cache._cache_client.exists(cache._meta_key("/a"))


@pytest.mark.asyncio
async def test_a_losing_tokenless_add_leaves_the_incumbent_token_alone(cache):
    # The early return has to happen before the meta delete. A drain that
    # finishes late correctly declines to overwrite a newer fill; if it
    # still dropped that fill's token on the way out, the survivor would
    # be unverifiable and a `fresh` mount would refetch it on every read
    # -- turning this PR's measured one-off cost into a permanent one.
    await cache.set("/a", b"new", fingerprint="etag-new")
    assert not await cache.add("/a", b"stale-drain")
    assert await cache.get("/a") == b"new"
    assert await cache.is_fresh("/a", "etag-new")


def test_the_two_add_lua_copies_are_byte_identical():
    # `redis.py` says so in a comment and nothing enforced it. This PR is
    # the first edit to the file, and the '' sentinel only works if both
    # hosts run the same script.
    root = pathlib.Path(__file__).resolve().parents[3].parent
    py = (root / "python/mirage/cache/file/add.lua").read_bytes()
    ts = (root /
          "typescript/packages/node/src/cache/file/add.lua").read_bytes()
    assert py == ts


@pytest.mark.asyncio
async def test_a_fill_with_no_token_writes_no_meta_key(cache):
    await cache.set("/a", b"data")
    assert await cache.get("/a") == b"data"
    assert not await cache._cache_client.exists(cache._meta_key("/a"))
    assert not await cache.is_fresh("/a", "etag-1")


@pytest.mark.asyncio
async def test_a_tokenless_set_deletes_a_stale_meta_key(cache):
    """The one false positive the naive change would have introduced.

    Redis expires and evicts the data and meta keys independently, so a
    meta key can outlive the bytes it described. Re-filling without a
    token has to clear it; leaving it would let `is_fresh` match the old
    token against the new bytes and serve them as fresh.
    """
    await cache.set("/a", b"old", fingerprint="etag-old")
    assert await cache.is_fresh("/a", "etag-old")
    await cache.set("/a", b"new")
    assert await cache.get("/a") == b"new"
    assert not await cache.is_fresh("/a", "etag-old")
    assert not await cache._cache_client.exists(cache._meta_key("/a"))


@pytest.mark.asyncio
async def test_a_tokenless_add_deletes_a_meta_key_that_outlived_its_data(
        cache):
    """`add.lua` only checks the data key, so a surviving meta key is
    invisible to its insert-only guard and has to be dropped explicitly."""
    await cache.set("/a", b"old", fingerprint="etag-old")
    await cache._cache_client.delete(cache._data_key("/a"))
    assert await cache._cache_client.exists(cache._meta_key("/a"))
    assert await cache.add("/a", b"new")
    assert await cache.get("/a") == b"new"
    assert not await cache.is_fresh("/a", "etag-old")
    assert not await cache._cache_client.exists(cache._meta_key("/a"))


@pytest.mark.asyncio
async def test_an_empty_token_is_treated_as_absent(cache):
    await cache.set("/a", b"data", fingerprint="")
    assert not await cache._cache_client.exists(cache._meta_key("/a"))
    assert not await cache.is_fresh("/a", "")
