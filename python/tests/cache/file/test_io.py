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

import pytest

from mirage.cache.file import io as cache_io
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.observe.record import OpRecord
from mirage.types import CacheFacts


def _record(
    op: str, path: str, fingerprint: str | None, nbytes: int = 0
) -> OpRecord:
    return OpRecord(
        op=op,
        path=path,
        source="s3",
        bytes=nbytes,
        timestamp=0,
        duration_ms=0,
        fingerprint=fingerprint,
    )


def _facts(ttl: int = 60, cacheable: bool = True):
    return lambda _path: CacheFacts(cacheable=cacheable, ttl=ttl)


def test_latest_fingerprint_reads_only_reads():
    # A write's own record labels the bytes it sent; here it would stamp
    # the write's token onto bytes a read produced, and the entry would
    # read as fresh forever.
    records = [
        _record("read", "/s3/f.txt", "etag-1", 3),
        _record("write", "/s3/f.txt", "etag-2", 3),
        _record("readdir", "/s3/f.txt", "etag-3", 3),
    ]
    assert cache_io.latest_fingerprint(records, "/s3/f.txt") == "etag-1"


def test_latest_fingerprint_stops_at_a_newer_read_without_a_token():
    # One line read the path twice and the backend vouched only for the
    # first: the bytes stored are the second read's, so the first read's
    # token would label bytes it never described.
    records = [
        _record("read", "/m/f.txt", "token-a", 3),
        _record("read", "/m/f.txt", None, 3),
    ]
    assert cache_io.latest_fingerprint(records, "/m/f.txt") is None


@pytest.mark.asyncio
async def test_kept_bytes_take_their_token_and_the_bound():
    cache = RAMFileCacheStore()
    await cache_io.set_cached(cache, "/s3/f.txt", b"hello", "etag", _facts(45))
    assert await cache.get("/s3/f.txt") == b"hello"
    assert await cache.is_fresh("/s3/f.txt", "etag")
    assert cache._entries["/s3/f.txt"].ttl == 45


@pytest.mark.asyncio
async def test_a_path_its_mount_does_not_cache_keeps_nothing():
    cache = RAMFileCacheStore()
    await cache_io.set_cached(
        cache, "/s3/f.txt", b"hello", None, _facts(cacheable=False)
    )
    assert not await cache.exists("/s3/f.txt")


@pytest.mark.asyncio
async def test_bytes_bigger_than_the_cache_are_not_kept():
    # Bytes bigger than the cache would flush it; the stale copy goes too.
    cache = RAMFileCacheStore(cache_limit=10)
    await cache.set("/s3/warm", b"abc")
    await cache.set("/s3/big", b"old")
    await cache_io.set_cached(cache, "/s3/big", b"x" * 11, None, _facts())
    assert not await cache.exists("/s3/big")
    assert await cache.get("/s3/warm") == b"abc"


@pytest.mark.asyncio
@pytest.mark.parametrize("down", [False, True])
async def test_a_store_that_refuses_never_fails_the_write(
    refusing_store, down
):
    # The write landed: a refused fill, or a refused drop too, is no
    # failure, and the stale copy goes when it can.
    cache = refusing_store(down=down)
    await RAMFileCacheStore.set(cache, "/s3/f", b"old")
    await cache_io.set_cached(cache, "/s3/f", b"new", None, _facts())
    if not down:
        assert not await cache.exists("/s3/f")
