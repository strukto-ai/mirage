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
from mirage.observe.context import LostPaths, line_version
from mirage.observe.record import (
    READ_FINGERPRINT_OPS,
    STAMP_FINGERPRINT_OPS,
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

    Reads only: a write's own record labels the bytes it sent. Backends
    stamp a read record with
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
        records (list[OpRecord] | None): the records the read emitted.
        path (str): Virtual path used as the cache key.
    """
    if records is None:
        return None
    for rec in reversed(records):
        if rec.op in READ_FINGERPRINT_OPS and rec.path == path:
            return rec.fingerprint or None
    return None


async def set_cached(
    cache: FileCacheMixin,
    path: str,
    data: bytes,
    fingerprint: str | None,
    cache_facts: Callable[[str], CacheFacts],
) -> None:
    """Keep ``data`` for ``path`` under the mutation lock.

    The facts are read under the lock, so a mount that stopped owning the
    path, or stopped caching it, keeps nothing.

    Args:
        cache (FileCacheMixin): The file cache to fill.
        path (str): Virtual path used as the cache key.
        data (bytes): The bytes to store.
        fingerprint (str | None): their backend token, None when the
            backend vouched for none.
        cache_facts (Callable[[str], CacheFacts]): Per-path cacheability
            and ttl.
    """
    async with mutation_lock(cache):
        facts = cache_facts(path)
        if not facts.cacheable:
            return
        if len(data) > cache.cache_limit:
            # Bytes over the whole cache limit would evict every warm entry.
            await cache.remove(path)
            return
        await _store(cache, path, data, fingerprint, facts.ttl)


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


async def keep_versions(
    cache: FileCacheMixin,
    records: list[OpRecord],
    cache_facts: Callable[[str], CacheFacts],
    lost: LostPaths | None,
    nested: bool = False,
) -> None:
    """Keep the version each path last had on the line, on conditional mounts.

    A read that fills no cache (``grep``, ``head``) or a write that keeps
    no bytes (``>>``, a resize, a cross-mount ``cp``) still names the
    version it saw, and the next line's write on a conditional mount needs
    it; so does a refusal, whose read may have been served from the cache
    and left no record. Runs when the line ends.

    Args:
        cache (FileCacheMixin): the file cache.
        records (list[OpRecord]): the line's records.
        cache_facts (Callable[[str], CacheFacts]): per-path facts.
        lost (LostPaths | None): the line's lost paths.
        nested (bool): a nested line's (``eval``, ``$(...)``): it keeps
            only the versions of paths still lost; its line keeps the
            rest. Its read records do not count: a concurrent sibling
            stage records into the same list.
    """
    if nested:
        records = [r for r in records if r.op not in READ_FINGERPRINT_OPS]
    index = RecordIndex(records)
    paths = (
        set()
        if nested
        else {
            rec.path
            for rec in records
            if rec.op in STAMP_FINGERPRINT_OPS and rec.fingerprint
        }
    )
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
