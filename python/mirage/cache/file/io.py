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

from mirage.cache.file.mixin import FileCacheMixin
from mirage.io import CachableAsyncIterator, IOResult
from mirage.observe.record import OpRecord

logger = logging.getLogger(__name__)


def read_fingerprint(records: list[OpRecord] | None, path: str) -> str | None:
    """Latest backend fingerprint recorded for a read of ``path``.

    Backends stamp read records with the content identifier they
    returned (S3 ETag, OneDrive cTag, Postgres sha256). Threading it
    into the cache entry lets ALWAYS-mode ``is_fresh`` compare like
    with like; the MD5-of-content default only matches simple-PUT S3
    objects.

    Args:
        records (list[OpRecord] | None): Op records emitted by the
            command that produced the IOResult being applied.
        path (str): Virtual path used as the cache key.
    """
    if records is None:
        return None
    for rec in reversed(records):
        if rec.op == "read" and rec.path == path and rec.fingerprint:
            return rec.fingerprint
    return None


async def _set_cached(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    records: list[OpRecord] | None,
) -> None:
    fingerprint = read_fingerprint(records, path)
    if fingerprint is None and await cache.get(path) == data:
        # Warm read: the bytes were served from this cache, so there is
        # no backend read record. Re-setting would replace the backend
        # fingerprint stamped on the cold read with the MD5 default and
        # force ALWAYS mode to evict and refetch on every read.
        return
    await cache.set(path, data, fingerprint=fingerprint)


async def apply_io(
    cache: FileCacheMixin,
    io: IOResult,
    is_cacheable: Callable[[str], bool] | None = None,
    records: list[OpRecord] | None = None,
) -> None:
    cache_set = set(io.cache)
    max_bytes = getattr(cache, "max_drain_bytes", None)
    for path in io.cache:
        if is_cacheable is not None and not is_cacheable(path):
            continue
        data = io.reads.get(path)
        if data is None:
            data = io.writes.get(path)
        if data is None:
            continue
        if isinstance(data, bytes):
            await _set_cached(cache, path, data, records)
        elif isinstance(data, CachableAsyncIterator):
            if data.exhausted:
                await _set_cached(cache, path, b"".join(data.buffered_chunks),
                                  records)
            else:
                if (hasattr(cache, "_drain_tasks")
                        and path not in cache._drain_tasks
                        and not await cache.exists(path)):
                    task = asyncio.create_task(
                        _background_drain(cache, path, data, max_bytes,
                                          records))
                    cache._drain_tasks[path] = task
                    task.add_done_callback(
                        lambda t, p=path: cache._drain_tasks.pop(p, None))
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
    max_bytes: int | None = None,
    records: list[OpRecord] | None = None,
) -> None:
    """Drain an unconsumed stream and write to cache.

    Cancelled by workspace.close() if the stream is still draining at
    shutdown. If max_bytes is set and the drain exceeds it without
    exhausting the source, the partial buffer is discarded and the path
    is not cached (next read will fetch fresh from the resource).
    The fingerprint is looked up after the drain: streaming backends
    stamp their read record lazily, once the GET response arrives.
    """
    try:
        if max_bytes is None:
            materialized = await it.drain()
            await cache.add(path,
                            materialized,
                            fingerprint=read_fingerprint(records, path))
            return
        materialized, fully_drained = await it.drain_bounded(max_bytes)
        if fully_drained:
            await cache.add(path,
                            materialized,
                            fingerprint=read_fingerprint(records, path))
        else:
            logger.info(
                "cache drain budget exceeded for %s "
                "(>%d bytes), skipping cache fill", path, max_bytes)
    except asyncio.CancelledError:
        logger.warning("background drain cancelled for %s", path)
    except Exception:
        logger.warning("background drain failed for %s", path, exc_info=True)
