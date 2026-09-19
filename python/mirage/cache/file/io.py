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
from functools import partial
from typing import Any, Callable
from weakref import WeakKeyDictionary

from mirage.cache.file.mixin import FileCacheMixin
from mirage.io import CachableAsyncIterator, IOResult
from mirage.observe.record import (READ_FINGERPRINT_OPS, WRITE_FINGERPRINT_OPS,
                                   OpRecord)

logger = logging.getLogger(__name__)
_mutation_locks: WeakKeyDictionary[FileCacheMixin,
                                   asyncio.Lock] = WeakKeyDictionary()


def mutation_lock(cache: FileCacheMixin) -> asyncio.Lock:
    """Serialize cache fills with mount ownership changes."""
    lock = _mutation_locks.get(cache)
    if lock is None:
        lock = asyncio.Lock()
        _mutation_locks[cache] = lock
    return lock


def latest_fingerprint(records: list[OpRecord] | None, path: str,
                       ops: frozenset[str], nbytes: int) -> str | None:
    """Latest backend fingerprint recorded for ``path`` by one of ``ops``.

    Backends stamp a read record with the content identifier they
    returned (S3 ETag, OneDrive cTag, Postgres sha256), and an
    object-store write record with the token its PUT answered.
    Threading it into the cache entry lets ALWAYS-mode ``is_fresh``
    compare like with like; the MD5-of-content default only matches
    simple-PUT S3 objects.

    ``ops`` is the direction the caller took, never both. One line's
    records span every statement and pipeline segment (``IOResult.merge``
    unions them), so a path read and written on the same line carries a
    record of each; asking for the wrong direction stamps the write's
    token onto the bytes the read produced, and the entry then reads as
    fresh forever.

    Args:
        records (list[OpRecord] | None): Op records emitted by the
            command that produced the IOResult being applied.
        path (str): Virtual path used as the cache key.
        ops (frozenset[str]): ``READ_FINGERPRINT_OPS`` when the bytes
            came from ``IOResult.reads``, ``WRITE_FINGERPRINT_OPS`` when
            they came from ``IOResult.writes``.
        nbytes (int): length of the bytes about to be stored, which a
            write's token has to agree with.
    """
    if records is None:
        return None
    for rec in reversed(records):
        if rec.op in ops and rec.path == path and rec.fingerprint:
            if rec.op in WRITE_FINGERPRINT_OPS and rec.bytes != nbytes:
                # Direction is not identity: a line can hold several ops
                # for one path while apply_io stores the bytes of just
                # one of them, and `IOResult.merge` is right-wins on
                # `writes`, so the empty eviction marker a server-side
                # `cp` leaves there displaces the content `tee` wrote
                # while `tee`'s record stays the last one (a copy that
                # streams writes its own record, and the guard catches
                # that one on the source's length instead). A token for
                # a different length describes
                # different bytes, and a wrong token reads as fresh for
                # the life of the entry, so answer none and let the
                # content default stand.
                return None
            return rec.fingerprint
    return None


async def _set_cached(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    records: list[OpRecord] | None,
    is_cacheable: Callable[[str], bool] | None,
    ops: frozenset[str],
) -> None:
    async with mutation_lock(cache):
        if is_cacheable is None or is_cacheable(path):
            await _set_cached_locked(cache, path, data, records, ops)


async def _set_cached_locked(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    records: list[OpRecord] | None,
    ops: frozenset[str],
) -> None:
    fingerprint = latest_fingerprint(records, path, ops, len(data))
    if fingerprint is None and await cache.get(path) == data:
        # Warm read: the bytes were served from this cache, so there is
        # no backend read record. Re-setting would replace the backend
        # fingerprint stamped on the cold read with the MD5 default and
        # force ALWAYS mode to evict and refetch on every read.
        return
    await cache.set(path, data, fingerprint=fingerprint)


def _drop_drain_task(cache: FileCacheMixin, path: str,
                     task: asyncio.Task[Any]) -> None:
    if cache._drain_tasks.get(path) is task:
        cache._drain_tasks.pop(path, None)


async def apply_io(
    cache: FileCacheMixin,
    io: IOResult,
    is_cacheable: Callable[[str], bool] | None = None,
    records: list[OpRecord] | None = None,
) -> None:
    cache_set = set(io.cache)
    for path in io.cache:
        if is_cacheable is not None and not is_cacheable(path):
            continue
        data = io.reads.get(path)
        # The token has to describe the bytes actually stored, so the
        # lookup asks about the side this branch took.
        ops = READ_FINGERPRINT_OPS
        if data is None:
            data = io.writes.get(path)
            ops = WRITE_FINGERPRINT_OPS
        if data is None:
            continue
        if isinstance(data, bytes):
            await _set_cached(cache, path, data, records, is_cacheable, ops)
        elif isinstance(data, CachableAsyncIterator):
            if data.discarded:
                continue
            if data.exhausted:
                await _set_cached(cache, path, b"".join(data.buffered_chunks),
                                  records, is_cacheable, ops)
            else:
                if (hasattr(cache, "_drain_tasks")
                        and path not in cache._drain_tasks
                        and not await cache.exists(path)):
                    task = asyncio.create_task(
                        _background_drain(cache, path, data,
                                          cache.drain_budget, ops, records,
                                          is_cacheable))
                    cache._drain_tasks[path] = task
                    task.add_done_callback(
                        partial(_drop_drain_task, cache, path))
    for path in io.writes:
        if path in cache_set:
            continue
        if is_cacheable is not None and not is_cacheable(path):
            continue
        await cache.remove(path)


async def _background_drain(
    cache: FileCacheMixin,
    path: str,
    it: CachableAsyncIterator,
    max_bytes: int,
    ops: frozenset[str],
    records: list[OpRecord] | None = None,
    is_cacheable: Callable[[str], bool] | None = None,
) -> None:
    """Drain an unconsumed stream and write to cache.

    Cancelled by workspace.close() if the stream is still draining at
    shutdown. If the drain exceeds max_bytes (the cache's drain_budget)
    without exhausting the source, the partial buffer is discarded and
    the path is not cached (next read will fetch fresh from the
    VFS). The fingerprint is looked up after the drain: streaming
    backends stamp their read record lazily, once the GET response
    arrives.
    """
    try:
        materialized = await it.drain_bounded(max_bytes)
        if materialized is not None:
            async with mutation_lock(cache):
                if (cache._drain_tasks.get(path) is asyncio.current_task()
                        and (is_cacheable is None or is_cacheable(path))):
                    await cache.add(path,
                                    materialized,
                                    fingerprint=latest_fingerprint(
                                        records, path, ops, len(materialized)))
        else:
            logger.info(
                "cache drain budget exceeded for %s "
                "(>%d bytes), skipping cache fill", path, max_bytes)
    except asyncio.CancelledError:
        logger.warning("background drain cancelled for %s", path)
    except Exception:
        logger.warning("background drain failed for %s", path, exc_info=True)
