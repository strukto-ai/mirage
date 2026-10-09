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
import logging
from typing import Callable
from weakref import WeakKeyDictionary

from mirage.cache.file.mixin import FileCacheMixin
from mirage.io import CachableAsyncIterator, IOResult
from mirage.io.types import ByteSource
from mirage.observe.context import LostPaths, line_version
from mirage.observe.record import (
    READ_FINGERPRINT_OPS,
    STAMP_FINGERPRINT_OPS,
    WRITE_FINGERPRINT_OPS,
    OpRecord,
    RecordIndex,
)
from mirage.types import CacheFacts

logger = logging.getLogger(__name__)
_mutation_locks: WeakKeyDictionary[FileCacheMixin, asyncio.Lock] = (
    WeakKeyDictionary()
)


def mutation_lock(cache: FileCacheMixin) -> asyncio.Lock:
    """Serialize cache fills with mount ownership changes."""
    lock = _mutation_locks.get(cache)
    if lock is None:
        lock = asyncio.Lock()
        _mutation_locks[cache] = lock
    return lock


def latest_fingerprint(
    records: list[OpRecord] | None, path: str
) -> str | None:
    """Latest backend fingerprint a read recorded for ``path``.

    Reads only: written bytes are decided by :func:`written_verdict`, so
    there is one rule per direction. Backends stamp a read record with
    the content identifier they returned (S3 ETag, OneDrive cTag,
    Postgres sha256). Threading it into the cache entry lets a ``fresh``
    mount's ``is_fresh`` compare like with like. None means the bytes
    carry no token, and the entry then stores none: an unverifiable copy
    is dropped and re-read, which is what a fabricated one produced
    anyway on every backend whose token is not an md5 of the content.

    Only the newest read of the path counts: when it carries no token,
    neither does the entry, whatever an earlier read stamped. The
    backend did not vouch for the bytes stored, and an older read's
    token would label bytes it never described, which a later revert to
    that token serves as fresh.

    Args:
        records (list[OpRecord] | None): Op records emitted by the
            command that produced the IOResult being applied.
        path (str): Virtual path used as the cache key.
    """
    if records is None:
        return None
    for rec in reversed(records):
        if rec.op in READ_FINGERPRINT_OPS and rec.path == path:
            return rec.fingerprint or None
    return None


def written_verdict(
    records: list[OpRecord] | None,
    path: str,
    written: ByteSource,
    nbytes: int,
) -> tuple[bool, str | None]:
    """Whether a line keeps the bytes it wrote to ``path``, and their token.

    Only the newest ``write`` or ``truncate`` record of the path counts.
    Its ``claimed`` value is what the command that made it put in
    ``IOResult.writes``, so it vouches for ``written`` only when it is
    that very value, or equal bytes. Any other value means another writer
    landed last (a concurrent pipeline stage, an ``xargs -P`` run, a
    background job, a dispatcher write that claims nothing, a ``truncate``),
    and neither the cached bytes nor the pre-write entry are the file. A
    size other than ``nbytes`` means the write moved other bytes than
    the command claims. A line with no write record for the path keeps
    its bytes untokened.

    Args:
        records (list[OpRecord] | None): Op records of the line whose
            IOResult is being applied.
        path (str): Virtual path used as the cache key.
        written (ByteSource): The original ``IOResult.writes`` value for
            ``path``, never bytes joined from it.
        nbytes (int): length of the bytes about to be stored.

    Returns:
        tuple[bool, str | None]: ``(True, token)`` to keep, labelled with
        the newest write's token or None; ``(False, None)`` to drop.
    """
    if records is None:
        return True, None
    newest = next(
        (
            rec
            for rec in reversed(records)
            if (rec.op in WRITE_FINGERPRINT_OPS or rec.op == "truncate")
            and rec.path == path
        ),
        None,
    )
    if newest is None:
        return True, None
    if newest.op == "truncate":
        return False, None
    claimed = newest.claimed
    if claimed is not written and not (
        isinstance(claimed, bytes)
        and isinstance(written, bytes)
        and claimed == written
    ):
        return False, None
    if newest.bytes != nbytes:
        return False, None
    return True, newest.fingerprint or None


async def _set_cached(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    written: ByteSource | None,
    records: list[OpRecord] | None,
    cache_facts: Callable[[str], CacheFacts] | None,
) -> None:
    """Store ``data`` for ``path`` under the mutation lock.

    Args:
        cache (FileCacheMixin): The file cache to fill.
        path (str): Virtual path used as the cache key.
        data (bytes): The bytes to store.
        written (ByteSource | None): The original ``IOResult.writes``
            value when ``data`` was written, None when a read produced it.
        records (list[OpRecord] | None): Op records of the line.
        cache_facts (Callable[[str], CacheFacts] | None): Per-path
            cacheability and ttl.
    """
    async with mutation_lock(cache):
        facts = cache_facts(path) if cache_facts is not None else None
        # `cacheable` is read first and short-circuits, so `ttl` is never
        # consulted for a path that is not being cached. That ordering is
        # what keeps an unresolvable mount from being read as "no bound".
        if facts is None or facts.cacheable:
            await _set_cached_locked(
                cache,
                path,
                data,
                written,
                records,
                facts.ttl if facts else None,
            )


async def _set_cached_locked(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    written: ByteSource | None,
    records: list[OpRecord] | None,
    # No default: the one caller always has a bound to pass, and
    # omitting it would write an entry no `bounded` mount can ever
    # expire -- the population the gate's self-heal exists to clean up.
    # Required in the TypeScript twin for the same reason.
    ttl: int | None,
) -> None:
    if len(data) > cache.cache_limit:
        # Bytes over the whole cache limit would evict every warm entry.
        await cache.remove(path)
        return
    if written is not None:
        keep, token = written_verdict(records, path, written, len(data))
        if not keep:
            # The claimed path is skipped by apply_io's eviction loop, so
            # the pre-write entry has to go here.
            await cache.remove(path)
            return
        await _store(cache, path, data, token, ttl)
        return
    fingerprint = latest_fingerprint(records, path)
    if fingerprint is None and await cache.exists(path):
        # A tokenless read over a live entry is a warm read: these
        # bytes came out of this entry, so re-setting would drop the
        # backend fingerprint and force a ``fresh`` mount to refetch,
        # while fetching the blob back to compare it with itself is the
        # file over the wire twice.
        return
    await _store(cache, path, data, fingerprint, ttl)


async def _store(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    fingerprint: str | None,
    ttl: int | None,
) -> None:
    """Store bytes the line settled on, never failing the line for it.

    The read or write behind them already happened; a store that refuses
    the fill (out of memory, a value over its size limit) costs the next
    read a fetch, so it is logged and the stale entry dropped.

    Args:
        cache (FileCacheMixin): the file cache.
        path (str): virtual path used as the cache key.
        data (bytes): the bytes to store.
        fingerprint (str | None): their token.
        ttl (int | None): the mount's bound.
    """
    try:
        await cache.set(path, data, fingerprint=fingerprint, ttl=ttl)
    except Exception:
        logger.warning("cache fill refused for %s", path, exc_info=True)
        try:
            await cache.remove(path)
        except Exception:
            logger.warning(
                "stale copy not dropped for %s", path, exc_info=True
            )


def _gone(
    index: RecordIndex | None, lost: LostPaths | None, path: str
) -> bool:
    """Whether the line no longer knows the bytes it holds for ``path``.

    A path whose conditional write lost, or whose newest version record
    removed or moved it (its own or an ancestor's), is not the file those
    bytes describe any more.

    Args:
        index (RecordIndex | None): the line's records, indexed.
        lost (LostPaths | None): the line's lost paths.
        path (str): virtual path used as the cache key.
    """
    if lost is not None and lost.holds(path):
        return True
    if index is None:
        return False
    return _retracted(index.newest_version(path))


def _retracted(rec: OpRecord | None) -> bool:
    """Whether a path's newest version record removed or moved it.

    Args:
        rec (OpRecord | None): the newest version record, if any.
    """
    return rec is not None and rec.op not in STAMP_FINGERPRINT_OPS


async def _keep_versions(
    cache: FileCacheMixin,
    records: list[OpRecord],
    index: RecordIndex,
    cache_facts: Callable[[str], CacheFacts],
    lost: LostPaths | None,
) -> None:
    """Keep the version each path last had on the line, on conditional mounts.

    A read that fills no cache (``grep``, ``head``) or a write that claims
    no bytes (``>>``, a resize, a cross-mount ``cp``) still names the
    version it saw, and the next line's write on a conditional mount needs
    it; so does a refusal, whose read may have been served from the cache
    and left no record. Runs after the bytes are settled, so it never
    undoes a removal.

    Args:
        cache (FileCacheMixin): the file cache.
        records (list[OpRecord]): the line's records.
        index (RecordIndex): the same records, indexed.
        cache_facts (Callable[[str], CacheFacts]): per-path facts.
        lost (LostPaths | None): the line's lost paths.
    """
    paths = {
        rec.path
        for rec in records
        if rec.op in STAMP_FINGERPRINT_OPS and rec.fingerprint
    }
    if lost is not None:
        paths.update(key for key in lost.marks if lost.holds(key))
    versions: dict[str, str] = {}
    for path in paths:
        facts = cache_facts(path)
        if not (facts.cacheable and facts.keeps_versions):
            continue
        _, version = line_version(index, lost, path)
        if version:
            versions[path] = version
    if not versions:
        return
    try:
        async with mutation_lock(cache):
            await cache.keep_fingerprints(versions)
    except Exception:
        logger.warning(
            "versions not kept for %d paths, first %s",
            len(versions),
            min(versions),
            exc_info=True,
        )


async def apply_io(
    cache: FileCacheMixin,
    io: IOResult,
    cache_facts: Callable[[str], CacheFacts] | None = None,
    records: list[OpRecord] | None = None,
    lost: LostPaths | None = None,
    nested: bool = False,
) -> None:
    """Settle what a command read and wrote into the file cache.

    Args:
        cache (FileCacheMixin): the file cache.
        io (IOResult): the command's reads, writes and cache claims.
        cache_facts (Callable[[str], CacheFacts] | None): per-path facts.
        records (list[OpRecord] | None): the line's records.
        lost (LostPaths | None): the line's lost paths.
        nested (bool): a nested line's (``eval``, ``$(...)``): it keeps
            only the versions of paths still lost; its line keeps the rest.
            Its read records only order reads after writes: a concurrent
            sibling stage records into the same list, and its read token
            would label bytes this line read before the change.
    """
    # A path both read and written is dropped: neither side is the file.
    # A read at the dispatcher reaches here as the backend's read record, and
    # counts once it follows the path's last write: the dispatcher kept what
    # the backend held by then, which need not be the bytes sent.
    read_after: set[str] = set()
    for rec in records or ():
        if rec.op in WRITE_FINGERPRINT_OPS:
            read_after.discard(rec.path)
        elif rec.op in READ_FINGERPRINT_OPS:
            read_after.add(rec.path)
    if nested and records is not None:
        records = [r for r in records if r.op not in READ_FINGERPRINT_OPS]
    read = set(io.reads) | read_after
    kept = [p for p in io.cache if p not in read or p not in io.writes]
    cache_set = set(kept)
    index = RecordIndex(records) if records is not None else None
    for path in kept:
        facts = cache_facts(path) if cache_facts is not None else None
        if facts is not None and not facts.cacheable:
            continue
        # Only a conditional mount names what the line removed or lost.
        if (facts is None or facts.keeps_versions) and _gone(
            index, lost, path
        ):
            await cache.remove(path)
            continue
        # The token has to describe the bytes actually stored, so the
        # side this branch took decides which records label them.
        data = io.reads.get(path)
        written: ByteSource | None = None
        if data is None:
            data = written = io.writes.get(path)
        if data is None:
            continue
        if isinstance(data, bytes):
            await _set_cached(cache, path, data, written, records, cache_facts)
        elif isinstance(data, CachableAsyncIterator):
            if written is not None and (data.discarded or not data.exhausted):
                # No claimer returns a written stream it did not finish
                # (a discard marks a stream exhausted and empty), and its
                # bytes are not the file's; the eviction loop below skips
                # claimed paths, so the pre-write entry goes.
                await cache.remove(path)
                continue
            if data.discarded:
                continue
            if data.exhausted:
                await _set_cached(
                    cache,
                    path,
                    b"".join(data.buffered_chunks),
                    written,
                    records,
                    cache_facts,
                )
    for path in io.writes:
        if path in cache_set:
            continue
        if cache_facts is not None and not cache_facts(path).cacheable:
            continue
        await cache.remove(path)
    if records is not None and index is not None and cache_facts is not None:
        await _keep_versions(
            cache, [] if nested else records, index, cache_facts, lost
        )
    # An unfinished read keeps nothing and is closed; unmount waits on it.
    for data in io.reads.values():
        if isinstance(data, CachableAsyncIterator) and not data.exhausted:
            await data.discard()
