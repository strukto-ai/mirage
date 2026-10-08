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

from mirage.cache.file.redis import DEL_BATCH, RedisFileCacheStore

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def cache(redis_prefix):
    c = RedisFileCacheStore(
        cache_limit="1MB",
        url=REDIS_URL,
        key_prefix=redis_prefix,
    )
    await c.clear()
    yield c
    await c.clear()
    # The cache's clear() drops cached data, not the keys its VFS store
    # wrote (the root directory set), and the prefix is this test's own.
    await c.accessor.store.clear()
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
async def test_key_prefix_isolation(redis_prefix):
    c1 = RedisFileCacheStore(url=REDIS_URL, key_prefix=f"{redis_prefix}ns1:")
    c2 = RedisFileCacheStore(url=REDIS_URL, key_prefix=f"{redis_prefix}ns2:")
    await c1.clear()
    await c2.clear()
    await c1.set("/shared", b"from-c1")
    assert await c2.get("/shared") is None
    assert await c1.get("/shared") == b"from-c1"
    for c in (c1, c2):
        await c.clear()
        await c.accessor.store.clear()
        await c.close()


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
async def test_an_empty_token_is_treated_as_absent(cache):
    await cache.set("/a", b"data", fingerprint="")
    assert not await cache._cache_client.exists(cache._meta_key("/a"))
    assert not await cache.is_fresh("/a", "")


@pytest.mark.asyncio
async def test_prefix_eviction_preserves_nested_mount(cache):
    for key in (
        "/data/sub/old",
        "/data/sub/nested",
        "/data/sub/nested/file",
        "/data/sub/nested2",
    ):
        await cache.set(key, b"value")
    await cache.evict_prefix("/data/sub/", excluded=("/data/sub/nested",))
    assert await cache.get("/data/sub/nested") == b"value"
    assert await cache.get("/data/sub/nested/file") == b"value"
    assert await cache.get("/data/sub/old") is None
    assert await cache.get("/data/sub/nested2") is None


async def _evict_t(cache) -> None:
    await cache.evict_prefix("/t/")


async def _clear(cache) -> None:
    await cache.clear()


_PREFIX_DROPS = pytest.mark.parametrize(
    "drop", [_evict_t, _clear], ids=["evict_prefix", "clear"]
)


def _spy(client, name: str) -> list[tuple]:
    """Record every call of ``client.<name>`` and pass it through.

    Counted on this store's own client, not with ``INFO commandstats``:
    the server is shared with every other Redis test running at once.

    Args:
        client (Redis): the store's client.
        name (str): the command method to wrap.
    """
    calls: list[tuple] = []
    real = getattr(client, name)

    async def wrapper(*args, **kwargs):
        calls.append(args)
        return await real(*args, **kwargs)

    setattr(client, name, wrapper)
    return calls


def _spy_pipelines(client) -> list[list[int]]:
    """Record, per pipeline the client opens, how many keys each DEL names.

    Args:
        client (Redis): the store's client.
    """
    pipelines: list[list[int]] = []
    real = client.pipeline

    def pipeline(*args, **kwargs):
        pipe = real(*args, **kwargs)
        sizes: list[int] = []
        pipelines.append(sizes)
        real_delete = pipe.delete

        def delete(*keys):
            sizes.append(len(keys))
            return real_delete(*keys)

        pipe.delete = delete
        return pipe

    client.pipeline = pipeline
    return pipelines


async def _seed_unrelated(client, prefix: str, count: int) -> None:
    pipe = client.pipeline(transaction=False)
    for i in range(count):
        pipe.set(f"{prefix}{i}", b"x")
    await pipe.execute()


async def _drop_unrelated(client, prefix: str) -> None:
    keys = [k async for k in client.scan_iter(f"{prefix}*", count=1000)]
    if keys:
        await client.delete(*keys)


async def _cached_keys(cache) -> list[str]:
    keys = [
        k.decode() if isinstance(k, bytes) else k
        async for k in cache._cache_client.scan_iter(
            f"{cache._data_prefix}*", count=1000
        )
    ]
    keys += [
        k.decode() if isinstance(k, bytes) else k
        async for k in cache._cache_client.scan_iter(
            f"{cache._meta_prefix}*", count=1000
        )
    ]
    return sorted(keys)


@pytest.mark.asyncio
@_PREFIX_DROPS
async def test_a_prefix_drop_scans_the_server_once_in_large_pages(
    cache, redis_prefix, drop
):
    # One pass over data and meta together, at COUNT 1000: the number of
    # SCAN calls is about dbsize / 1000. Two passes double it, and the
    # client default (COUNT 10) makes it about dbsize / 5 -- 191k round
    # trips per call at 1M server keys.
    client = cache._cache_client
    unrelated = f"{redis_prefix}unrelated:"
    await _seed_unrelated(client, unrelated, 5000)
    try:
        await cache.set("/t/a", b"x", fingerprint="etag")
        scans = _spy(client, "scan")
        await drop(cache)
        pages = -(-(await client.dbsize()) // 1000)
        # At least one: a spy that sees no SCAN would pass the bound below.
        assert len(scans) > 0
        assert len(scans) <= pages + 2
        assert await cache.get("/t/a") is None
        assert not await client.exists(cache._meta_key("/t/a"))
    finally:
        await _drop_unrelated(client, unrelated)


@pytest.mark.asyncio
async def test_a_prefix_drop_spanning_pages_takes_data_and_meta_and_nothing_else(
    cache,
):
    for i in range(2500):
        await cache.set(f"/t/sub/{i}", b"x", fingerprint="etag")
    await cache.set("/t/subway", b"keep", fingerprint="etag")
    await cache.set("/t/sub/nested/kept", b"keep", fingerprint="etag")
    pipelines = _spy_pipelines(cache._cache_client)
    await cache.evict_prefix("/t/sub/", excluded=("/t/sub/nested",))
    # Deleted page by page, each page in DELs of at most DEL_BATCH keys:
    # one DEL of N keys blocks the server for all N at once, and N bodies
    # may each be large. A page goes out as one pipeline, one round trip.
    sizes = [n for pipe in pipelines for n in pipe]
    assert len(pipelines) >= 3
    assert max(sizes) <= DEL_BATCH
    assert any(len(pipe) > 1 for pipe in pipelines)
    assert sum(sizes) == 5000
    assert await _cached_keys(cache) == sorted(
        [
            cache._data_key("/t/sub/nested/kept"),
            cache._data_key("/t/subway"),
            cache._meta_key("/t/sub/nested/kept"),
            cache._meta_key("/t/subway"),
        ]
    )


@pytest.mark.asyncio
@_PREFIX_DROPS
async def test_a_prefix_drop_takes_only_the_cache_keys(
    cache, redis_prefix, drop
):
    # `[dm][ae]ta:` also matches `mata:`, and the VFS store shares the key
    # prefix. A shared server can hold any bytes as a key: one under the
    # cache's own `data:` goes, and the drop does not stop on it.
    client = cache._cache_client
    bad = b"\xff\xfe"
    own = f"{redis_prefix}data:/t/".encode() + bad
    kept = [
        f"{redis_prefix}mata:/t/x".encode(),
        f"{redis_prefix}file:/t/x".encode(),
        f"{redis_prefix}mata:/t/".encode() + bad,
    ]
    for key in (own, *kept):
        await client.set(key, b"x")
    try:
        await cache.set("/t/x", b"x", fingerprint="etag")
        await drop(cache)
        assert await cache.get("/t/x") is None
        assert not await client.exists(own)
        assert await client.exists(*kept) == len(kept)
    finally:
        await client.delete(own, *kept)


@pytest.mark.asyncio
@_PREFIX_DROPS
async def test_a_key_prefix_with_glob_characters_matches_only_itself(
    redis_prefix, drop
):
    globbed = RedisFileCacheStore(
        url=REDIS_URL, key_prefix=f"{redis_prefix}[1]:"
    )
    plain = RedisFileCacheStore(url=REDIS_URL, key_prefix=f"{redis_prefix}1:")
    try:
        await globbed.set("/t/x", b"mine")
        await plain.set("/t/x", b"other")
        await drop(globbed)
        assert await globbed.get("/t/x") is None
        assert await plain.get("/t/x") == b"other"
    finally:
        await plain.clear()
        await globbed.clear()
        await plain.close()
        await globbed.close()


@pytest.mark.asyncio
async def test_a_prefix_drop_under_non_ascii_names(redis_prefix):
    # A key prefix and a nested mount named in UTF-8 match only once both
    # sides are compared in the same form.
    accented = RedisFileCacheStore(
        url=REDIS_URL, key_prefix=f"{redis_prefix}café:"
    )
    try:
        await accented.set("/t/café/f", b"x")
        await accented.set("/t/other", b"x")
        await accented.evict_prefix("/t/", excluded=("/t/café",))
        assert await accented.get("/t/café/f") == b"x"
        assert await accented.get("/t/other") is None
    finally:
        await accented.clear()
        await accented.close()
