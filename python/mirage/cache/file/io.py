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
from mirage.observe.record import READ_FINGERPRINT_OPS, OpRecord
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
    """Backend fingerprint of the newest read of ``path``.

    Backends stamp a read record with the content identifier they
    returned (S3 ETag, OneDrive cTag, Postgres sha256). Threading it into
    the cache entry lets a ``fresh`` mount's ``is_fresh`` compare like with
    like. None means the bytes carry no token, and the entry then stores
    none: an unverifiable copy is dropped and re-read, which is what a
    fabricated one produced anyway on every backend whose token is not an
    md5 of the content.

    Only the newest read of the path counts: when it carries no token,
    neither does the entry, whatever an earlier read stamped. A write's
    token never labels read bytes; a writer settles its own bytes with
    the cache (``settle_after_write``).

    Args:
        records (list[OpRecord] | None): Op records emitted by the
            command that produced the IOResult being applied.
        path (str): Virtual path used as the cache key.
    """
    if records is None:
        return None
    for rec in reversed(records):
        if rec.op in READ_FINGERPRINT_OPS and rec.path == path:
            # The newest read is the one whose bytes are stored; an older
            # read's token would label bytes it never described, which a
            # later revert to that token serves as fresh.
            return rec.fingerprint or None
    return None


async def _set_cached(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    records: list[OpRecord] | None,
    cache_facts: Callable[[str], CacheFacts] | None,
) -> None:
    async with mutation_lock(cache):
        facts = cache_facts(path) if cache_facts is not None else None
        # `cacheable` is read first and short-circuits, so `ttl` is never
        # consulted for a path that is not being cached. That ordering is
        # what keeps an unresolvable mount from being read as "no bound".
        if facts is None or facts.cacheable:
            await _set_cached_locked(
                cache, path, data, records, facts.ttl if facts else None
            )


async def _set_cached_locked(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    records: list[OpRecord] | None,
    # No default: the one caller always has a bound to pass, and
    # omitting it would write an entry no `bounded` mount can ever
    # expire -- the population the gate's self-heal exists to clean up.
    # Required in the TypeScript twin for the same reason.
    ttl: int | None,
) -> None:
    fingerprint = latest_fingerprint(records, path)
    if fingerprint is None and await cache.exists(path):
        # A tokenless read over a live entry is a warm read: these
        # bytes came out of this entry, so re-setting would drop the
        # backend fingerprint and force a ``fresh`` mount to refetch,
        # while fetching the blob back to compare it with itself is the
        # file over the wire twice. Only `cp`'s
        # guarded walk reads the backend raw with an entry standing,
        # and only under ``bounded``, which already calls that entry
        # trusted.
        return
    await cache.set(path, data, fingerprint=fingerprint, ttl=ttl)


def _drop_drain_task(
    cache: FileCacheMixin, path: str, task: asyncio.Task[Any]
) -> None:
    if cache._drain_tasks.get(path) is task:
        cache._drain_tasks.pop(path, None)


async def apply_io(
    cache: FileCacheMixin,
    io: IOResult,
    cache_facts: Callable[[str], CacheFacts] | None = None,
    records: list[OpRecord] | None = None,
) -> None:
    """Fill the cache with the bytes a command line read.

    ``IOResult.cache`` lists read paths only: a writer settles what it
    wrote with the cache at the write (``settle_after_write``), and every
    other mutation evicts at its mutation site.

    Args:
        cache (FileCacheMixin): the workspace file cache.
        io (IOResult): the line's merged result.
        cache_facts (Callable[[str], CacheFacts] | None): per-path
            cacheability and bound.
        records (list[OpRecord] | None): the line's op records.
    """
    for path in io.cache:
        if cache_facts is not None and not cache_facts(path).cacheable:
            continue
        if path in io.writes:
            # The line also wrote the path, and an IOResult keeps no order
            # between a read and a write: the read may be the pre-write
            # bytes (`cat a; tee a`). The write already settled what the
            # cache holds for it.
            continue
        data = io.reads.get(path)
        if data is None:
            continue
        if isinstance(data, bytes):
            await _set_cached(cache, path, data, records, cache_facts)
        elif isinstance(data, CachableAsyncIterator):
            if data.discarded:
                continue
            if data.exhausted:
                await _set_cached(
                    cache,
                    path,
                    b"".join(data.buffered_chunks),
                    records,
                    cache_facts,
                )
            else:
                if (
                    hasattr(cache, "_drain_tasks")
                    and path not in cache._drain_tasks
                    and not await cache.exists(path)
                ):
                    task = asyncio.create_task(
                        _background_drain(
                            cache,
                            path,
                            data,
                            cache.drain_budget,
                            records,
                            cache_facts,
                        )
                    )
                    cache._drain_tasks[path] = task
                    task.add_done_callback(
                        partial(_drop_drain_task, cache, path)
                    )


async def _background_drain(
    cache: FileCacheMixin,
    path: str,
    it: CachableAsyncIterator,
    max_bytes: int,
    records: list[OpRecord] | None = None,
    cache_facts: Callable[[str], CacheFacts] | None = None,
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
                facts = cache_facts(path) if cache_facts is not None else None
                # The large-object path stamps the bound too, or a
                # streamed read would be the one thing `bounded` never
                # expires.
                if cache._drain_tasks.get(path) is asyncio.current_task() and (
                    facts is None or facts.cacheable
                ):
                    await cache.add(
                        path,
                        materialized,
                        fingerprint=latest_fingerprint(records, path),
                        ttl=facts.ttl if facts else None,
                    )
        else:
            logger.info(
                "cache drain budget exceeded for %s "
                "(>%d bytes), skipping cache fill",
                path,
                max_bytes,
            )
    except asyncio.CancelledError:
        logger.warning("background drain cancelled for %s", path)
    except Exception:
        logger.warning("background drain failed for %s", path, exc_info=True)
