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
import hashlib
import json
from collections.abc import Coroutine

import pytest

from mirage.cache.file.ram import RAMFileCacheStore
from mirage.workspace.snapshot.keys import CacheKey
from mirage.workspace.snapshot.state import _restore_cache


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


# `asyncio.Lock.acquire` does not suspend on a free lock, and neither store
# holds the key's lock across an await, so a writer never parks on its own.
# The tests below take the lock themselves; that is what forces the writer
# to park and makes the invalidation guard observable at all.


@pytest.mark.asyncio
async def test_a_cancelled_write_keeps_the_previous_entry():
    # Cancellation safety, not a race: the writer is cancelled while parked
    # on the lock, so `set` unwinds through its `finally` and must leave
    # both the previous entry and the writer bookkeeping untouched. Nothing
    # else covers `_invalidation.leave` surviving a cancellation.
    cache = RAMFileCacheStore(cache_limit="64MB")
    await cache.set("/file", b"old", fingerprint="etag-old")
    lock = cache._lock_for("/file")
    await lock.acquire()
    try:
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(cache.set("/file", b"new"), 0.02)
    finally:
        lock.release()
    assert await cache.get("/file") == b"old"
    assert cache.cache_size == 3
    assert await cache.is_fresh("/file", "etag-old")
    assert cache._invalidation._writers == {}


def _fill(
    cache: RAMFileCacheStore, operation: str, key: str
) -> Coroutine[None, None, bool | None]:
    if operation == "keep_fingerprints":
        return cache.keep_fingerprints({key: "v1"})
    return getattr(cache, operation)(key, b"x")


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["set", "keep_fingerprints"])
async def test_clear_while_a_writer_is_parked_discards_its_write(operation):
    cache = RAMFileCacheStore()
    lock = cache._lock_for("/large")
    await lock.acquire()
    pending = asyncio.create_task(_fill(cache, operation, "/large"))
    clearing: asyncio.Task[None] | None = None
    try:
        await asyncio.sleep(0.01)
        # `clear` bumps the epoch synchronously, before its first await, so
        # the parked writer sees it the moment it is granted the lock.
        clearing = asyncio.create_task(cache.clear())
        await asyncio.sleep(0.01)
    finally:
        lock.release()
    await asyncio.gather(pending, clearing)
    assert await cache.get("/large") is None
    assert await cache.fingerprint("/large") is None
    assert cache.cache_size == 0


@pytest.mark.asyncio
async def test_evict_prefix_while_a_writer_is_parked_discards_its_write():
    cache = RAMFileCacheStore()
    lock = cache._lock_for("/large")
    await lock.acquire()
    pending = asyncio.create_task(cache.set("/large", b"x"))
    evicting: asyncio.Task[None] | None = None
    try:
        await asyncio.sleep(0.01)
        evicting = asyncio.create_task(cache.evict_prefix("/lar"))
        await asyncio.sleep(0.01)
    finally:
        lock.release()
    await asyncio.gather(pending, evicting)
    assert await cache.get("/large") is None


@pytest.mark.asyncio
async def test_a_writer_queued_behind_a_removal_of_its_key_is_discarded():
    # The per-key counter as `remove` advances it, under the key's lock:
    # the clear case above bumps the store-wide epoch instead. The second writer holds
    # bytes read before the removal, so it must not repopulate the key that
    # was just dropped.
    #
    # A sleep after *each* task, not just at the end: `remove` finishes by
    # dropping the key's lock (`_discard_lock`), so a writer that had not yet
    # reached `_lock_for` would take a fresh lock, never queue behind the
    # removal, and the assertion would hold for the wrong reason.
    cache = RAMFileCacheStore()
    lock = cache._lock_for("/large")
    await lock.acquire()
    first = asyncio.create_task(cache.set("/large", b"x"))
    await asyncio.sleep(0.01)
    removal = asyncio.create_task(cache.remove("/large"))
    await asyncio.sleep(0.01)
    second = asyncio.create_task(cache.set("/large", b"y"))
    await asyncio.sleep(0.01)
    lock.release()
    await asyncio.gather(first, removal, second)
    assert await cache.get("/large") is None


@pytest.mark.asyncio
async def test_a_parked_fill_survives_the_removal_of_another_key():
    # Per-key scoping: a removal of an unrelated key must not throw away a
    # fill that is waiting its turn. `remove` takes a different lock, so it
    # runs to completion while this writer is still parked.
    cache = RAMFileCacheStore()
    data = b"x" * 1000
    lock = cache._lock_for("/large")
    await lock.acquire()
    fill = asyncio.create_task(cache.set("/large", data))
    try:
        await asyncio.sleep(0.01)
        await cache.remove("/other")
    finally:
        lock.release()
    await fill
    assert await cache.get("/large") == data


@pytest.mark.asyncio
async def test_a_parked_fill_survives_a_prefix_eviction_elsewhere():
    # Prefix scoping: `rm -r /a` or `mv /a ...` must not throw away a fill
    # of an unrelated key that is waiting its turn.
    cache = RAMFileCacheStore()
    lock = cache._lock_for("/b")
    await lock.acquire()
    fill = asyncio.create_task(cache.set("/b", b"x"))
    try:
        await asyncio.sleep(0.01)
        await cache.evict_prefix("/a/")
    finally:
        lock.release()
    await fill
    assert await cache.get("/b") == b"x"


@pytest.mark.asyncio
async def test_a_fill_with_no_token_stores_none():
    """The entry records what the backend said, and says nothing when the
    backend said nothing. Inventing md5(content) made the entry claim a
    token it did not have, which `is_fresh` then rejected on every backend
    whose own token is not an md5 of the content."""
    cache = RAMFileCacheStore()
    await cache.set("/a", b"data")
    assert cache._entries["/a"].fingerprint is None


@pytest.mark.asyncio
async def test_an_empty_token_is_stored_as_none():
    """`""` and None mean the same thing at both write doors, so the redis
    store's `''`-means-none wire convention cannot disagree with this one."""
    cache = RAMFileCacheStore()
    await cache.set("/a", b"data", fingerprint="")
    assert cache._entries["/a"].fingerprint is None


@pytest.mark.asyncio
async def test_a_snapshot_round_trip_preserves_both_token_states():
    # Capture and restore in one test because the pair is the contract:
    # a tokenless entry that came back holding md5(data) would read as
    # FRESH on a simple-PUT S3 object, and a token-bearing entry that came
    # back holding None would refetch forever. Both are silent.
    src = RAMFileCacheStore()
    await src.set("/none", b"data")
    await src.set("/tok", b"data", fingerprint="etag-1")
    captured = [
        {
            CacheKey.KEY: k,
            CacheKey.DATA: src._store.files[k],
            CacheKey.FINGERPRINT: e.fingerprint,
            CacheKey.TTL: e.ttl,
            CacheKey.CACHED_AT: e.cached_at,
            CacheKey.SIZE: e.size,
        }
        for k, e in src._entries.items()
    ]
    # Through JSON, because that is what a snapshot actually survives.
    for entry in captured:
        entry[CacheKey.DATA] = entry[CacheKey.DATA].decode()
    revived = json.loads(json.dumps(captured))
    for entry in revived:
        entry[CacheKey.DATA] = entry[CacheKey.DATA].encode()

    dst = RAMFileCacheStore()

    class _WS:
        pass

    ws = _WS()
    ws.cache = dst
    _restore_cache(ws, {"cache": {"entries": revived}})

    assert dst._entries["/none"].fingerprint is None
    assert not await dst.is_fresh("/none", hashlib.md5(b"data").hexdigest())
    assert await dst.is_fresh("/tok", "etag-1")


@pytest.mark.asyncio
@pytest.mark.parametrize("stored", ["", None])
async def test_a_restored_entry_folds_a_tokenless_spelling_like_a_write(
    stored,
):
    # The snapshot is a third door into the entry table, and it has to
    # agree with `set`/`add` about what "no token" is. A document is not
    # obliged to spell it the way this version does: an older writer
    # stored `""`, and an entry restored holding it would answer
    # `is_fresh(path, "")` with True where a freshly written one answers
    # False -- a false FRESH, which is the one direction that serves wrong
    # bytes.
    cache = RAMFileCacheStore()

    class _WS:
        pass

    ws = _WS()
    ws.cache = cache
    _restore_cache(
        ws,
        {
            "cache": {
                "entries": [
                    {
                        CacheKey.KEY: "/a",
                        CacheKey.DATA: b"x",
                        CacheKey.FINGERPRINT: stored,
                        CacheKey.TTL: None,
                        CacheKey.CACHED_AT: 0,
                        CacheKey.SIZE: 1,
                    }
                ]
            }
        },
    )
    assert cache._entries["/a"].fingerprint is None
    assert not await cache.is_fresh("/a", "")


@pytest.mark.asyncio
async def test_an_entry_with_no_token_is_never_fresh():
    cache = RAMFileCacheStore()
    await cache.set("/a", b"data")
    assert not await cache.is_fresh("/a", "etag-1")
    assert not await cache.is_fresh("/a", hashlib.md5(b"data").hexdigest())


@pytest.mark.asyncio
@pytest.mark.parametrize("remote", ["etag-1", "", None])
async def test_a_tokenless_entry_answers_no_whatever_it_is_asked(remote):
    # Including a remote that is itself absent. `_probe` never asks then
    # -- it answers UNKNOWN on a stat that carries no fingerprint, one
    # line earlier -- but the store is what has to hold the rule: two
    # absences comparing equal is a FRESH verdict on a copy nothing
    # verified, and the redis store, whose meta key is simply missing,
    # already answers False for the same pair. A store that disagrees
    # with its twin only for an input the caller is not supposed to
    # send is the shape that passes every RAM-backed test and diverges
    # in production.
    cache = RAMFileCacheStore()
    await cache.set("/a", b"data")
    assert not await cache.is_fresh("/a", remote)


@pytest.mark.asyncio
async def test_is_unbounded_distinguishes_absent_from_boundless():
    """One question, not `exists` plus a ttl lookup.

    A warm bounded read asks this on every serve, so it costs one store
    round trip; and a missing entry must answer False rather than reading
    as unbounded, or the gate would evict nothing and refuse everything.
    """
    cache = RAMFileCacheStore()
    assert await cache.is_unbounded("/absent") is False
    await cache.set("/no-bound", b"x")
    assert await cache.is_unbounded("/no-bound") is True
    await cache.set("/bounded", b"x", ttl=30)
    assert await cache.is_unbounded("/bounded") is False


@pytest.mark.asyncio
async def test_a_version_kept_without_bytes_is_never_read():
    cache = RAMFileCacheStore()
    await cache.keep_fingerprints({"/a": "v1"})
    assert not await cache.exists("/a")
    assert await cache.get("/a") is None
    assert not await cache.is_fresh("/a", "v1")
    assert not await cache.is_unbounded("/a")
    assert await cache.fingerprint("/a") == "v1"
    await cache.set("/a", b"read", fingerprint="v1")
    assert await cache.get("/a") == b"read"


@pytest.mark.asyncio
async def test_a_version_never_replaces_bytes_written_since():
    cache = RAMFileCacheStore()
    await cache.set("/a", b"theirs", fingerprint="v2")
    await cache.keep_fingerprints({"/a": "v1"})
    assert await cache.get("/a") == b"theirs"
    assert await cache.fingerprint("/a") == "v2"
    await cache.remove("/a")
    assert await cache.fingerprint("/a") is None


@pytest.mark.asyncio
async def test_a_version_replaces_bytes_past_their_bound():
    # Past its bound the entry vouches for nothing; keep the version seen since.
    cache = RAMFileCacheStore()
    await cache.set("/a", b"old", fingerprint="v1", ttl=0)
    await cache.keep_fingerprints({"/a": "v2"})
    assert await cache.fingerprint("/a") == "v2"
    assert await cache.get("/a") is None
    # The old bytes leave the store with their entry, not outside the limit.
    assert "/a" not in cache._store.files


@pytest.mark.asyncio
async def test_a_version_restamped_counts_its_size_once():
    cache = RAMFileCacheStore()
    for token in ("v1", "v2", "v3"):
        await cache.keep_fingerprints({"/a": token})
    assert cache.cache_size == len("/a") + len("v3")


@pytest.mark.asyncio
async def test_a_version_an_expiry_leaves_stays_within_the_limit():
    cache = RAMFileCacheStore(cache_limit=20)
    await cache.set("/a-long-key", b"x", fingerprint="v1234567890", ttl=1)
    await cache.keep_fingerprints({"/a-long-key": "v1234567890"})
    cache._entries["/a-long-key"].cached_at -= 10
    assert await cache.get("/a-long-key") is None
    assert cache.cache_size <= 20


@pytest.mark.asyncio
@pytest.mark.parametrize("kept", [True, False], ids=["kept", "not kept"])
async def test_an_expired_entry_still_answers_its_version(kept):
    # The token stays true for the bytes read, all a condition says; a
    # version kept for a conditional mount outlives its bytes, as on redis.
    cache = RAMFileCacheStore()
    await cache.set("/a", b"x", fingerprint="v1", ttl=1)
    if kept:
        await cache.keep_fingerprints({"/a": "v1"})
    cache._entries["/a"].cached_at -= 10
    assert not await cache.exists("/a")
    assert await cache.fingerprint("/a") == "v1"
    assert await cache.get("/a") is None
    assert await cache.fingerprint("/a") == ("v1" if kept else None)
    assert "/a" not in cache._store.files
