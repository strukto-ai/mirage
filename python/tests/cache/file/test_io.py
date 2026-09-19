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

import pytest

from mirage.cache.file import io as cache_io
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.io import CachableAsyncIterator, IOResult
from mirage.io.stream import close_quietly
from mirage.observe.record import (READ_FINGERPRINT_OPS, WRITE_FINGERPRINT_OPS,
                                   OpRecord)


def _record(op: str,
            path: str,
            fingerprint: str | None,
            nbytes: int = 0) -> OpRecord:
    return OpRecord(op=op,
                    path=path,
                    source="s3",
                    bytes=nbytes,
                    timestamp=0,
                    duration_ms=0,
                    fingerprint=fingerprint)


def _read_record(path: str, fingerprint: str | None) -> OpRecord:
    return _record("read", path, fingerprint)


async def _one_chunk(data: bytes):
    yield data


@pytest.fixture
def cache():
    return RAMFileCacheStore()


# ── cache population via apply_io ────────────────────────────────────────


@pytest.mark.asyncio
async def test_apply_io_caches_reads(cache):
    """Command reads a file → apply_io stores it in cache."""
    io = IOResult(
        reads={"/data/file.txt": b"hello"},
        cache=["/data/file.txt"],
    )
    await cache_io.apply_io(cache, io)
    assert await cache.get("/data/file.txt") == b"hello"


@pytest.mark.asyncio
async def test_apply_io_caches_writes(cache):
    """Command writes a file and marks it cacheable → stored in cache."""
    io = IOResult(
        writes={"/data/out.txt": b"output"},
        cache=["/data/out.txt"],
    )
    await cache_io.apply_io(cache, io)
    assert await cache.get("/data/out.txt") == b"output"


@pytest.mark.asyncio
async def test_apply_io_reads_preferred_over_writes(cache):
    """When both reads and writes exist for same path, read data wins."""
    io = IOResult(
        reads={"/f.txt": b"read-data"},
        writes={"/f.txt": b"write-data"},
        cache=["/f.txt"],
    )
    await cache_io.apply_io(cache, io)
    assert await cache.get("/f.txt") == b"read-data"


@pytest.mark.asyncio
async def test_apply_io_multiple_paths(cache):
    """Multiple paths in cache list are all stored."""
    io = IOResult(
        reads={
            "/a.txt": b"aaa",
            "/b.txt": b"bbb"
        },
        cache=["/a.txt", "/b.txt"],
    )
    await cache_io.apply_io(cache, io)
    assert await cache.get("/a.txt") == b"aaa"
    assert await cache.get("/b.txt") == b"bbb"


# ── backend fingerprint threading ───────────────────────────────────────


@pytest.mark.asyncio
async def test_apply_io_sets_backend_fingerprint_from_records(cache):
    """A read record with a backend fingerprint (ETag, cTag, sha256)
    stamps the cache entry, so ALWAYS-mode is_fresh can match it."""
    io = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    records = [_read_record("/s3/f.txt", "etag-multipart-2")]
    await cache_io.apply_io(cache, io, records=records)
    assert await cache.get("/s3/f.txt") == b"hello"
    assert await cache.is_fresh("/s3/f.txt", "etag-multipart-2")


@pytest.mark.asyncio
async def test_apply_io_exhausted_stream_uses_record_fingerprint(cache):
    """An exhausted stream read carries its record fingerprint too."""
    stream = _make_stream(b"hello")
    assert await stream.drain() == b"hello"
    io = IOResult(reads={"/s3/f.txt": stream}, cache=["/s3/f.txt"])
    records = [_read_record("/s3/f.txt", "etag-multipart-2")]
    await cache_io.apply_io(cache, io, records=records)
    assert await cache.is_fresh("/s3/f.txt", "etag-multipart-2")


@pytest.mark.asyncio
async def test_apply_io_warm_reapply_preserves_fingerprint(cache):
    """A warm read re-applies cache-served bytes with no backend read
    record; the entry's backend fingerprint must survive, not be
    replaced by the MD5-of-content default."""
    cold = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache,
                            cold,
                            records=[_read_record("/s3/f.txt", "etag-3")])
    warm = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, warm, records=[])
    assert await cache.is_fresh("/s3/f.txt", "etag-3")


@pytest.mark.asyncio
async def test_apply_io_changed_data_without_record_resets_entry(cache):
    """New bytes with no backend fingerprint still replace the entry."""
    cold = IOResult(reads={"/s3/f.txt": b"old"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache,
                            cold,
                            records=[_read_record("/s3/f.txt", "etag-3")])
    fresh = IOResult(writes={"/s3/f.txt": b"new"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, fresh, records=[])
    assert await cache.get("/s3/f.txt") == b"new"
    assert not await cache.is_fresh("/s3/f.txt", "etag-3")


@pytest.mark.asyncio
async def test_apply_io_drain_uses_fingerprint_recorded_during_drain():
    """Streaming backends set the record fingerprint lazily when the GET
    response arrives, i.e. during the background drain. The drained
    entry must pick it up."""
    cache = RAMFileCacheStore()
    records: list[OpRecord] = []

    async def _gen():
        records.append(_read_record("/s3/f.txt", "etag-multipart-2"))
        yield b"hello"

    stream = CachableAsyncIterator(_gen())
    io = IOResult(reads={"/s3/f.txt": stream}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, io, records=records)
    await asyncio.sleep(0.05)
    assert await cache.get("/s3/f.txt") == b"hello"
    assert await cache.is_fresh("/s3/f.txt", "etag-multipart-2")


# ── cache invalidation ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_apply_io_write_without_cache_invalidates(cache):
    """Write to a path NOT in cache list → invalidate (remove from cache)."""
    await cache.set("/f.txt", b"old")
    io = IOResult(writes={"/f.txt": b"new"})
    await cache_io.apply_io(cache, io)
    assert await cache.get("/f.txt") is None


# ── edge cases ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_apply_io_no_cache_no_data_skips(cache):
    """Path in cache list but no data in reads/writes → skip, don't cache."""
    io = IOResult(cache=["/missing.txt"])
    await cache_io.apply_io(cache, io)
    assert await cache.get("/missing.txt") is None


@pytest.mark.asyncio
async def test_apply_io_empty_io(cache):
    """Empty IOResult → no-op."""
    io = IOResult()
    await cache_io.apply_io(cache, io)


# ── background drain ────────────────────────────────────────────────────


def _make_stream(data: bytes) -> CachableAsyncIterator:

    async def _gen():
        yield data

    return CachableAsyncIterator(_gen())


@pytest.mark.asyncio
async def test_no_duplicate_drain():
    """If a drain is already running for a path, a second apply_io
    should not start another drain. The first drain finishes and
    caches the data; the second stream is ignored."""
    cache = RAMFileCacheStore()
    stream1 = _make_stream(b"first")
    stream2 = _make_stream(b"second")
    io1 = IOResult(reads={"/f.txt": stream1}, cache=["/f.txt"])
    await cache_io.apply_io(cache, io1)
    assert "/f.txt" in cache._drain_tasks
    io2 = IOResult(reads={"/f.txt": stream2}, cache=["/f.txt"])
    await cache_io.apply_io(cache, io2)
    assert len([k for k in cache._drain_tasks if k == "/f.txt"]) == 1
    await asyncio.sleep(0.05)
    assert await cache.get("/f.txt") == b"first"


@pytest.mark.asyncio
async def test_no_drain_if_already_cached():
    """If the path is already in cache, don't start a drain even if
    apply_io receives an unconsumed stream for it. Existing cached
    data is preserved."""
    cache = RAMFileCacheStore()
    await cache.set("/f.txt", b"cached")
    stream = _make_stream(b"new")
    io = IOResult(reads={"/f.txt": stream}, cache=["/f.txt"])
    await cache_io.apply_io(cache, io)
    assert "/f.txt" not in cache._drain_tasks
    assert await cache.get("/f.txt") == b"cached"


@pytest.mark.asyncio
async def test_prefix_eviction_retires_a_fill_before_a_replacement_starts():
    cache = RAMFileCacheStore()
    started = asyncio.Event()
    release_old = asyncio.Event()
    release_new = asyncio.Event()

    async def old_stream():
        started.set()
        try:
            await release_old.wait()
        except asyncio.CancelledError:
            await release_old.wait()
        yield b"old account"

    async def new_stream():
        await release_new.wait()
        yield b"new account"

    path = "/data/file"
    await cache_io.apply_io(
        cache,
        IOResult(reads={path: CachableAsyncIterator(old_stream())},
                 cache=[path]))
    old = cache._drain_tasks[path]
    await started.wait()
    await cache.evict_prefix("/data/")
    assert path not in cache._drain_tasks
    await cache_io.apply_io(
        cache,
        IOResult(reads={path: CachableAsyncIterator(new_stream())},
                 cache=[path]))
    new = cache._drain_tasks[path]
    try:
        release_old.set()
        await old
        await asyncio.sleep(0)
        assert await cache.get(path) is None
        assert cache._drain_tasks[path] is new
        release_new.set()
        await new
        assert await cache.get(path) == b"new account"
    finally:
        release_old.set()
        release_new.set()
        await asyncio.gather(old, new, return_exceptions=True)


# ── max_drain_bytes (cancellable cache drain) ───────────────────────────


def _make_chunked_stream(chunks: list[bytes]) -> CachableAsyncIterator:

    async def _gen():
        for c in chunks:
            yield c

    return CachableAsyncIterator(_gen())


@pytest.mark.asyncio
async def test_drain_survives_pipeline_close_quietly():
    """SIGPIPE-style teardown must not starve the background drain.

    `cat big.json | head -n 5` consumes one chunk, then pipes.py calls
    close_quietly on the upstream stream. The drain must still pull the
    remainder and cache the FULL file — a partial entry would poison
    every later read of the path (integ regression: 8192-byte cache).
    """
    cache = RAMFileCacheStore()
    chunks = [b"a" * 100 for _ in range(10)]
    stream = _make_chunked_stream(chunks)
    await stream.__anext__()
    await close_quietly(stream)
    io = IOResult(reads={"/big.json": stream}, cache=["/big.json"])
    await cache_io.apply_io(cache, io)
    await asyncio.sleep(0.05)
    cached = await cache.get("/big.json")
    assert cached is not None and len(cached) == 1000


@pytest.mark.asyncio
async def test_drain_default_budget_is_cache_limit():
    """Default: drains up to cache_limit, never unbounded."""
    cache = RAMFileCacheStore(cache_limit=500)  # max_drain_bytes=None
    small = _make_chunked_stream([b"a" * 100 for _ in range(3)])
    huge = _make_chunked_stream([b"b" * 100 for _ in range(10)])
    io_small = IOResult(reads={"/small.txt": small}, cache=["/small.txt"])
    io_huge = IOResult(reads={"/huge.txt": huge}, cache=["/huge.txt"])
    await cache_io.apply_io(cache, io_small)
    await cache_io.apply_io(cache, io_huge)
    await asyncio.sleep(0.05)
    cached = await cache.get("/small.txt")
    assert cached is not None and len(cached) == 300
    # 1000 bytes exceeds the 500-byte cache_limit: the drain stops
    # instead of buffering a file the cache could never hold.
    assert await cache.get("/huge.txt") is None


@pytest.mark.asyncio
async def test_drain_over_budget_releases_buffer_and_preserves_cache():
    cache = RAMFileCacheStore(cache_limit=500, max_drain_bytes=300)
    await cache.set("/warm.txt", b"w" * 200)
    stream = _make_chunked_stream([b"c" * 100 for _ in range(10)])
    io = IOResult(reads={"/big.txt": stream}, cache=["/big.txt"])
    await cache_io.apply_io(cache, io)
    await asyncio.sleep(0.05)
    assert await cache.get("/warm.txt") == b"w" * 200
    assert await cache.get("/big.txt") is None
    assert stream.buffered_chunks == []


@pytest.mark.asyncio
async def test_drain_completes_below_threshold():
    """Source is smaller than threshold → full drain, cache populated."""
    cache = RAMFileCacheStore(max_drain_bytes=10000)
    chunks = [b"x" * 100 for _ in range(5)]  # 500 bytes total
    stream = _make_chunked_stream(chunks)
    io = IOResult(reads={"/small.txt": stream}, cache=["/small.txt"])
    await cache_io.apply_io(cache, io)
    await asyncio.sleep(0.05)
    cached = await cache.get("/small.txt")
    assert cached is not None and len(cached) == 500


@pytest.mark.asyncio
async def test_drain_cancelled_above_threshold():
    """Source exceeds threshold → drain stops, partial buffer NOT cached."""
    cache = RAMFileCacheStore(max_drain_bytes=300)
    chunks = [b"z" * 100 for _ in range(20)]  # 2000 bytes total
    stream = _make_chunked_stream(chunks)
    io = IOResult(reads={"/huge.txt": stream}, cache=["/huge.txt"])
    await cache_io.apply_io(cache, io)
    await asyncio.sleep(0.05)
    assert await cache.get("/huge.txt") is None


@pytest.mark.asyncio
async def test_drain_threshold_per_task_not_shared():
    """Each drain task has its own counter, not a shared workspace pool."""
    cache = RAMFileCacheStore(max_drain_bytes=300)
    s1 = _make_chunked_stream([b"a" * 100, b"a" * 100])  # 200 < 300
    s2 = _make_chunked_stream([b"b" * 100, b"b" * 100])  # 200 < 300
    io1 = IOResult(reads={"/a.txt": s1}, cache=["/a.txt"])
    io2 = IOResult(reads={"/b.txt": s2}, cache=["/b.txt"])
    await cache_io.apply_io(cache, io1)
    await cache_io.apply_io(cache, io2)
    await asyncio.sleep(0.05)
    # Both fit individually under the per-task budget → both cached.
    assert await cache.get("/a.txt") is not None
    assert await cache.get("/b.txt") is not None


# ── the token describes the bytes stored, not the other direction ────────


@pytest.mark.asyncio
async def test_apply_io_stamps_a_write_token_on_written_bytes(cache):
    """A write record's token reaches a written path's entry; before
    this, the entry fell back to md5(content)."""
    io = IOResult(writes={"/s3/f.txt": b"new"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, io, records=[_record("write", "/s3/f.txt", "etag-put-2", 3)])
    assert await cache.is_fresh("/s3/f.txt", "etag-put-2")


@pytest.mark.asyncio
async def test_apply_io_read_bytes_take_the_read_token_not_the_write(cache):
    """A line that reads and writes one path caches the read's bytes --
    apply_io prefers io.reads -- so the entry must carry the read's
    token. Stamping the write's would make is_fresh call stale bytes
    fresh for as long as the entry lives."""
    io = IOResult(reads={"/s3/f.txt": b"old"},
                  writes={"/s3/f.txt": b"new"},
                  cache=["/s3/f.txt"])
    await cache_io.apply_io(cache,
                            io,
                            records=[
                                _record("read", "/s3/f.txt", "etag-old-2", 3),
                                _record("write", "/s3/f.txt", "etag-new-2", 3),
                            ])
    assert await cache.get("/s3/f.txt") == b"old"
    assert await cache.is_fresh("/s3/f.txt", "etag-old-2")
    assert not await cache.is_fresh("/s3/f.txt", "etag-new-2")


@pytest.mark.asyncio
async def test_apply_io_written_bytes_ignore_an_earlier_read_token(cache):
    """sed -i lists the path in writes only, but emits its own pre-edit
    read record; the entry must carry the post-edit write token."""
    io = IOResult(writes={"/s3/f.txt": b"new"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache,
                            io,
                            records=[
                                _record("read", "/s3/f.txt", "etag-old-2", 3),
                                _record("write", "/s3/f.txt", "etag-new-2", 3),
                            ])
    assert await cache.is_fresh("/s3/f.txt", "etag-new-2")
    assert not await cache.is_fresh("/s3/f.txt", "etag-old-2")


@pytest.mark.asyncio
async def test_apply_io_streamed_read_takes_the_read_token(cache):
    """The stream branch is the same fork, so it answers the same way."""
    stream = CachableAsyncIterator(_one_chunk(b"old"))
    assert await stream.drain() == b"old"
    io = IOResult(reads={"/s3/f.txt": stream},
                  writes={"/s3/f.txt": b"new"},
                  cache=["/s3/f.txt"])
    await cache_io.apply_io(cache,
                            io,
                            records=[
                                _record("read", "/s3/f.txt", "etag-old-2", 3),
                                _record("write", "/s3/f.txt", "etag-new-2", 3),
                            ])
    assert await cache.is_fresh("/s3/f.txt", "etag-old-2")


@pytest.mark.asyncio
async def test_apply_io_drops_a_write_token_of_a_different_length(cache):
    """`cp` overwrites `IOResult.writes` with an empty eviction marker
    while the path stays in `cache` and the earlier `tee`'s record stays
    the last one, so the token would land on bytes it does not describe.
    A length disagreement is the proof it does not, and the entry falls
    back to the content default rather than reading as fresh forever."""
    io = IOResult(writes={"/s3/f.txt": b""}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, io, records=[_record("write", "/s3/f.txt", "etag-tee-2", 2)])
    assert await cache.get("/s3/f.txt") == b""
    assert not await cache.is_fresh("/s3/f.txt", "etag-tee-2")


@pytest.mark.parametrize("op", ["create", "truncate"])
@pytest.mark.asyncio
async def test_apply_io_ignores_ops_that_never_supply_bytes(cache, op):
    """`create` and `truncate` stamp a token on their own record but
    never hand bytes to the cache, so pairing one with another op's
    bytes is the mispairing WRITE_FINGERPRINT_OPS exists to refuse."""
    io = IOResult(writes={"/s3/f.txt": b"new"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, io, records=[_record(op, "/s3/f.txt", "etag-other-2", 3)])
    assert not await cache.is_fresh("/s3/f.txt", "etag-other-2")


def test_latest_fingerprint_matches_only_its_own_direction():
    records = [_record("read", "/s3/f.txt", "etag-2", 3)]
    assert cache_io.latest_fingerprint(records, "/s3/f.txt",
                                       READ_FINGERPRINT_OPS, 3) == "etag-2"
    assert cache_io.latest_fingerprint(records, "/s3/f.txt",
                                       WRITE_FINGERPRINT_OPS, 3) is None


def test_latest_fingerprint_ignores_an_op_in_neither_set():
    records = [_record("readdir", "/s3/f.txt", "etag-2", 3)]
    assert cache_io.latest_fingerprint(records, "/s3/f.txt",
                                       READ_FINGERPRINT_OPS, 3) is None
    assert cache_io.latest_fingerprint(records, "/s3/f.txt",
                                       WRITE_FINGERPRINT_OPS, 3) is None


def test_latest_fingerprint_does_not_size_check_a_read():
    """A read record's byte count tracks what was consumed, which a
    partially drained stream makes smaller than the bytes cached, so the
    identity rule is the write direction's alone."""
    records = [_record("read", "/s3/f.txt", "etag-2", 1)]
    assert cache_io.latest_fingerprint(records, "/s3/f.txt",
                                       READ_FINGERPRINT_OPS, 9) == "etag-2"
