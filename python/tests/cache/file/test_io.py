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
from mirage.io import CachableAsyncIterator, IOResult
from mirage.io.types import ByteSource
from mirage.observe.record import OpRecord
from mirage.types import CacheFacts


def _record(
    op: str,
    path: str,
    fingerprint: str | None,
    nbytes: int = 0,
    claimed: ByteSource | None = None,
) -> OpRecord:
    return OpRecord(
        op=op,
        path=path,
        source="s3",
        bytes=nbytes,
        timestamp=0,
        duration_ms=0,
        fingerprint=fingerprint,
        claimed=claimed,
    )


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
async def test_apply_io_drops_a_path_read_and_written(cache):
    """`cat f; printf z >> f` reads f before appending to it: neither
    side is the file, so the entry the line started with goes too."""
    await cache.set("/f.txt", b"stale")
    io = IOResult(
        reads={"/f.txt": b"read-data"},
        writes={"/f.txt": b"z"},
        cache=["/f.txt"],
    )
    await cache_io.apply_io(cache, io)
    assert await cache.get("/f.txt") is None


@pytest.mark.asyncio
async def test_apply_io_closes_an_unfinished_read_and_keeps_nothing(cache):
    closed: list[str] = []

    async def source():
        try:
            for chunk in (b"a", b"b", b"c"):
                yield chunk
        finally:
            closed.append("/f")

    stream = CachableAsyncIterator(source())
    assert await stream.__anext__() == b"a"
    await cache_io.apply_io(
        cache, IOResult(reads={"/f": stream}, cache=["/f"])
    )
    assert (await cache.get("/f"), stream.exhausted, closed) == (
        None,
        True,
        ["/f"],
    )


@pytest.mark.asyncio
async def test_apply_io_multiple_paths(cache):
    """Multiple paths in cache list are all stored."""
    io = IOResult(
        reads={"/a.txt": b"aaa", "/b.txt": b"bbb"},
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
    dropped for the no-token default."""
    cold = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, cold, records=[_read_record("/s3/f.txt", "etag-3")]
    )
    warm = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, warm, records=[])
    assert await cache.is_fresh("/s3/f.txt", "etag-3")


@pytest.mark.asyncio
async def test_apply_io_changed_data_without_record_resets_entry(cache):
    """New bytes with no backend fingerprint still replace the entry."""
    cold = IOResult(reads={"/s3/f.txt": b"old"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, cold, records=[_read_record("/s3/f.txt", "etag-3")]
    )
    fresh = IOResult(writes={"/s3/f.txt": b"new"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, fresh, records=[])
    assert await cache.get("/s3/f.txt") == b"new"
    assert not await cache.is_fresh("/s3/f.txt", "etag-3")


class _CountingCache(RAMFileCacheStore):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.gets = 0
        self.exists_calls = 0

    async def get(self, key: str) -> bytes | None:
        self.gets += 1
        return await super().get(key)

    async def exists(self, key: str) -> bool:
        self.exists_calls += 1
        return await super().exists(key)


@pytest.mark.asyncio
async def test_apply_io_warm_reapply_does_not_refetch_the_blob():
    """A warm re-apply asks whether the entry exists, never for its
    bytes. The read-through already served them out of that entry, so
    fetching the blob back to compare it with itself was the whole cost
    of #1009 -- on a Redis cache, the file over the wire twice."""
    cache = _CountingCache()
    cold = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, cold, records=[_read_record("/s3/f.txt", "etag-3")]
    )
    cache.gets = 0
    cache.exists_calls = 0
    warm = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, warm, records=[])
    assert cache.gets == 0
    assert cache.exists_calls == 1
    assert await cache.is_fresh("/s3/f.txt", "etag-3")


@pytest.mark.asyncio
async def test_apply_io_write_of_identical_bytes_replaces_the_entry():
    """A write always writes: the guard's existence check is gated on
    the read direction, so a backend that stamps no write token cannot
    skip the set and leave a pre-write entry standing. The bytes are
    identical here, so only the fingerprint can show it happened -- and
    the direction short-circuits before the cache is asked anything, so
    the write path costs no lookup at all."""
    cache = _CountingCache()
    cold = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, cold, records=[_read_record("/s3/f.txt", "etag-3")]
    )
    cache.gets = 0
    cache.exists_calls = 0
    rewrite = IOResult(writes={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, rewrite, records=[])
    assert cache.gets == 0
    assert cache.exists_calls == 0
    assert await cache.get("/s3/f.txt") == b"hello"
    assert not await cache.is_fresh("/s3/f.txt", "etag-3")


@pytest.mark.asyncio
async def test_apply_io_tokenless_read_keeps_the_entry_it_found(cache):
    """The one case the existence check answers differently from the
    byte compare it replaces: a read that reached the backend while an
    entry stood, with no token to stamp. Only `cp`'s guarded primitive
    walk reads that way, and ``bounded`` already calls the entry it
    kept trusted, so preserving it is the policy's answer rather than
    an accidental repair."""
    cold = IOResult(reads={"/s3/f.txt": b"old"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, cold, records=[_read_record("/s3/f.txt", "etag-3")]
    )
    raw = IOResult(reads={"/s3/f.txt": b"new"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, raw, records=[])
    assert await cache.get("/s3/f.txt") == b"old"
    assert await cache.is_fresh("/s3/f.txt", "etag-3")


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


def _make_stream(data: bytes) -> CachableAsyncIterator:
    async def _gen():
        yield data

    return CachableAsyncIterator(_gen())


# ── the token describes the bytes stored, not the other direction ────────


@pytest.mark.asyncio
async def test_apply_io_read_bytes_take_the_read_token_not_the_write(cache):
    """Read bytes carry the read's token even when a write record of the
    path comes later. Stamping the write's would make is_fresh call
    stale bytes fresh for as long as the entry lives."""
    io = IOResult(reads={"/s3/f.txt": b"old"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache,
        io,
        records=[
            _record("read", "/s3/f.txt", "etag-old-2", 3),
            _record("write", "/s3/f.txt", "etag-new-2", 3),
        ],
    )
    assert await cache.get("/s3/f.txt") == b"old"
    assert await cache.is_fresh("/s3/f.txt", "etag-old-2")
    assert not await cache.is_fresh("/s3/f.txt", "etag-new-2")


@pytest.mark.asyncio
async def test_apply_io_written_bytes_ignore_an_earlier_read_token(cache):
    """sed -i lists the path in writes only, but emits its own pre-edit
    read record; the entry must carry the post-edit write token."""
    written = b"new"
    io = IOResult(writes={"/s3/f.txt": written}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache,
        io,
        records=[
            _record("read", "/s3/f.txt", "etag-old-2", 3),
            _record("write", "/s3/f.txt", "etag-new-2", 3, written),
        ],
    )
    assert await cache.is_fresh("/s3/f.txt", "etag-new-2")
    assert not await cache.is_fresh("/s3/f.txt", "etag-old-2")


@pytest.mark.asyncio
async def test_apply_io_streamed_read_takes_the_read_token(cache):
    """The stream branch is the same fork, so it answers the same way."""
    stream = CachableAsyncIterator(_one_chunk(b"old"))
    assert await stream.drain() == b"old"
    io = IOResult(reads={"/s3/f.txt": stream}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache,
        io,
        records=[
            _record("read", "/s3/f.txt", "etag-old-2", 3),
            _record("write", "/s3/f.txt", "etag-new-2", 3),
        ],
    )
    assert await cache.is_fresh("/s3/f.txt", "etag-old-2")


def test_latest_fingerprint_reads_only_reads():
    # A write's token labels written bytes through written_verdict; here
    # it would stamp the write's token onto bytes a read produced, and the
    # entry would read as fresh forever.
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
async def test_apply_io_leaves_bytes_from_an_unvouched_read_untokened(cache):
    io = IOResult(reads={"/m/f.txt": b"new"}, cache=["/m/f.txt"])
    await cache_io.apply_io(
        cache,
        io,
        records=[
            _read_record("/m/f.txt", "token-a"),
            _read_record("/m/f.txt", None),
        ],
    )
    assert await cache.exists("/m/f.txt")
    assert not await cache.is_fresh("/m/f.txt", "token-a")


@pytest.mark.asyncio
async def test_apply_io_does_not_size_check_a_read(cache):
    # A read record's byte count tracks what was consumed, which a
    # partially drained stream makes smaller than the bytes cached, so
    # the size rule is the write direction's alone.
    io = IOResult(reads={"/s3/f.txt": b"abcdef"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(
        cache, io, records=[_record("read", "/s3/f.txt", "etag-2", 1)]
    )
    assert await cache.is_fresh("/s3/f.txt", "etag-2")


# ── written_verdict: which written bytes a line keeps ───────────────────


_WRITTEN = b"abc"


@pytest.mark.parametrize(
    ("records", "expected"),
    [
        pytest.param(None, (True, None), id="unrecorded"),
        pytest.param(
            [(bytes(bytearray(_WRITTEN)), 3)], (True, "Ta"), id="equal-copy"
        ),
        pytest.param([(b"abd", 3)], (False, None), id="last-byte-differs"),
        pytest.param([(b"ab", 3)], (False, None), id="shorter-prefix"),
        pytest.param([(_WRITTEN, 9)], (False, None), id="other-size"),
    ],
)
def test_written_verdict_where_no_shell_line_reaches(records, expected):
    # The workspace tests pin what a shell line shows. These rows are the
    # rest: an unrecorded apply, a claim that is an equal copy rather than
    # the very value cached, and a claim whose bytes or size differ.
    # Mirrors the TypeScript writtenVerdict table.
    recs = (
        None
        if records is None
        else [
            _record("write", "/f", "Ta", n, claimed) for claimed, n in records
        ]
    )
    assert cache_io.written_verdict(recs, "/f", _WRITTEN, 3) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "discard", [False, True], ids=["unfinished", "discarded"]
)
async def test_a_claimed_written_stream_left_open_evicts_the_entry(
    cache, discard
):
    # No claimer returns a written stream it did not finish, and its bytes
    # are not the file's; the eviction loop skips claimed paths, so the
    # pre-write entry goes here, with no drain.
    await cache.set("/s3/f.txt", b"old")
    stream = _make_stream(b"abc")
    if discard:
        await stream.discard()
    io = IOResult(writes={"/s3/f.txt": stream}, cache=["/s3/f.txt"])
    rec = _record("write", "/s3/f.txt", "etag-put-2", 3, stream)
    await cache_io.apply_io(cache, io, records=[rec])
    assert not await cache.exists("/s3/f.txt")


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True], ids=["bytes", "stream"])
@pytest.mark.parametrize(
    ("stored", "kept"), [(3, True), (99, False)], ids=["agrees", "differs"]
)
async def test_claimed_written_bytes_take_the_verdict(
    cache, stream, stored, kept
):
    # A stored size other than the bytes sent means neither they nor the
    # pre-write entry are the file, so the entry is removed, not skipped.
    # A finished stream takes the same verdict as bytes.
    await cache.set("/s3/f.txt", b"old")
    written: ByteSource = b"abc"
    if stream:
        written = _make_stream(b"abc")
        assert await written.drain() == b"abc"
    io = IOResult(writes={"/s3/f.txt": written}, cache=["/s3/f.txt"])
    rec = _record("write", "/s3/f.txt", "etag-put-2", stored, written)
    await cache_io.apply_io(cache, io, records=[rec])
    if kept:
        assert await cache.get("/s3/f.txt") == b"abc"
        assert await cache.is_fresh("/s3/f.txt", "etag-put-2")
    else:
        assert not await cache.exists("/s3/f.txt")


@pytest.mark.asyncio
@pytest.mark.parametrize("nested", [False, True], ids=["line", "nested"])
async def test_a_path_read_at_the_dispatcher_and_written_keeps_nothing(
    cache, nested
):
    # SharePoint rewrites an uploaded Office file, so the bytes `tee` sent
    # are not the file the dispatcher read back and kept; the read's record is
    # what tells apply_io the line read the path too, a nested line's
    # (`eval`) as well, whose read tokens label nothing.
    await cache.set("/s3/f.pptx", b"abc<meta/>")
    io = IOResult(writes={"/s3/f.pptx": b"abc"}, cache=["/s3/f.pptx"])
    records = [
        _record("write", "/s3/f.pptx", "etag-put-2", 3, b"abc"),
        _read_record("/s3/f.pptx", "etag-put-2"),
    ]
    await cache_io.apply_io(cache, io, records=records, nested=nested)
    assert not await cache.exists("/s3/f.pptx")


@pytest.mark.asyncio
@pytest.mark.parametrize("side", ["reads", "writes"])
async def test_bytes_bigger_than_the_cache_are_not_kept(side):
    # Bytes bigger than the cache would flush it; the stale copy goes too.
    cache = RAMFileCacheStore(cache_limit=10)
    await cache.set("/s3/warm", b"abc")
    await cache.set("/s3/big", b"old")
    io = IOResult(**{side: {"/s3/big": b"x" * 11}}, cache=["/s3/big"])
    await cache_io.apply_io(cache, io)
    assert not await cache.exists("/s3/big")
    assert await cache.get("/s3/warm") == b"abc"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "down, written", [(False, ["/s3/f", "/s3/other"]), (True, ["/s3/f"])]
)
async def test_a_store_that_refuses_never_fails_the_line(
    refusing_store, down, written
):
    # The write landed: a refused fill, or a refused drop too, is no failure.
    cache = refusing_store(down=down)
    for path in written:
        await RAMFileCacheStore.set(cache, path, b"old")
    io = IOResult(writes={p: b"new" for p in written}, cache=["/s3/f"])
    await cache_io.apply_io(cache, io)
    if not down:
        assert not await cache.exists("/s3/f")
        assert not await cache.exists("/s3/other")


# ── the mount's staleness bound reaches the entry ───────────────────────


def _facts(ttl: int, cacheable: bool = True):
    return lambda _path: CacheFacts(cacheable=cacheable, ttl=ttl)


@pytest.mark.asyncio
async def test_apply_io_stamps_the_bound_on_a_plain_read():
    cache = RAMFileCacheStore()
    io = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, io, _facts(45))
    assert cache._entries["/s3/f.txt"].ttl == 45


@pytest.mark.asyncio
async def test_apply_io_skips_a_path_its_mount_does_not_cache():
    """`cacheable` is read first and short-circuits.

    The bound is never consulted for a path that is not being cached,
    which is what keeps an unresolvable mount from reading as "no bound".
    """
    cache = RAMFileCacheStore()
    io = IOResult(reads={"/s3/f.txt": b"hello"}, cache=["/s3/f.txt"])
    await cache_io.apply_io(cache, io, _facts(30, cacheable=False))
    assert not await cache.exists("/s3/f.txt")


@pytest.mark.asyncio
async def test_apply_io_indexes_the_line_once(monkeypatch):
    # One index for every per-path lookup; one per path cost N passes.
    built = []
    real = cache_io.RecordIndex.__init__

    def counted(self, records):
        built.append(len(records))
        real(self, records)

    monkeypatch.setattr(cache_io.RecordIndex, "__init__", counted)
    paths = [f"/s3/f{i}" for i in range(50)]
    records = [
        OpRecord(
            op="read",
            path=p,
            source="s3",
            bytes=1,
            timestamp=0,
            duration_ms=0,
            fingerprint=f"v{i}",
        )
        for i, p in enumerate(paths)
    ]
    io = IOResult(reads={p: b"x" for p in paths}, cache=paths)
    await cache_io.apply_io(
        RAMFileCacheStore(),
        io,
        lambda _p: CacheFacts(cacheable=True, ttl=60, keeps_versions=True),
        records,
    )
    assert built == [len(records)]


class _RemovingStore(RAMFileCacheStore):
    def __init__(self, records: list[OpRecord], path: str) -> None:
        super().__init__()
        self._records = records
        self._path: str | None = path

    async def set(self, key: str, data: bytes, **kwargs) -> None:
        await super().set(key, data, **kwargs)
        if self._path is not None:
            self._records.append(_record("unlink", self._path, None))
            self._path = None


@pytest.mark.asyncio
async def test_apply_io_sees_a_removal_recorded_while_it_runs():
    # An rm a background job finishes mid-fill keeps the file out of the cache.
    records = [_record("read", "/s3/a", "va"), _record("read", "/s3/b", "vb")]
    cache = _RemovingStore(records, "/s3/b")
    io = IOResult(
        reads={"/s3/a": b"a", "/s3/b": b"b"}, cache=["/s3/a", "/s3/b"]
    )
    await cache_io.apply_io(
        cache,
        io,
        lambda _p: CacheFacts(cacheable=True, ttl=60, keeps_versions=True),
        records,
    )
    assert await cache.exists("/s3/a")
    assert not await cache.exists("/s3/b")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "versions, kept", [(True, False), (False, True)], ids=["cond", "uncond"]
)
async def test_apply_io_drops_a_removed_path_on_a_conditional_mount(
    versions, kept
):
    # A conditional mount drops a read the line then removed; others keep it.
    records = [
        _record("read", "/s3/a", "va"),
        _record("unlink", "/s3/a", None),
    ]
    cache = RAMFileCacheStore()
    io = IOResult(reads={"/s3/a": b"a"}, cache=["/s3/a"])
    await cache_io.apply_io(
        cache,
        io,
        lambda _p: CacheFacts(cacheable=True, ttl=60, keeps_versions=versions),
        records,
    )
    assert await cache.exists("/s3/a") is kept
