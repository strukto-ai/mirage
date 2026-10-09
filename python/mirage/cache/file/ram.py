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
import time
from collections import OrderedDict
from collections.abc import Iterable

from mirage.cache.file.entry import CacheEntry, Holds
from mirage.cache.file.mixin import FileCacheMixin, validate_max_drain_bytes
from mirage.cache.file.utils import parse_limit
from mirage.cache.invalidation import Invalidation
from mirage.cache.lock import KeyLockMixin
from mirage.types import PathSpec
from mirage.utils.key_prefix import under_path
from mirage.vfs.ram import RAMVFS


class RAMFileCacheStore(RAMVFS, FileCacheMixin, KeyLockMixin):
    """RAMVFS with LRU cache tracking.

    Data lives in inherited _store.files (RAMStore).
    _entries tracks LRU metadata only.
    All RAM commands (cat, grep, head, ...) inherited.
    """

    def __init__(
        self,
        cache_limit: str | int = "512MB",
        max_drain_bytes: int | None = None,
    ) -> None:
        parsed_limit = parse_limit(cache_limit)
        validate_max_drain_bytes(parsed_limit, max_drain_bytes)
        super().__init__()
        self._cache_limit: int = parsed_limit
        self._cache_size: int = 0
        self._invalidation = Invalidation()
        self._entries: OrderedDict[str, CacheEntry] = OrderedDict()
        self._clear_lock: asyncio.Lock = asyncio.Lock()
        self.max_drain_bytes: int | None = max_drain_bytes

    async def get(self, key: str) -> bytes | None:
        async with self._lock_for(key):
            entry = self._entries.get(key)
            if entry is None or not entry.has_bytes:
                return None
            if not entry.expired:
                self._entries.move_to_end(key)
                return self._store.files.get(key)
            self._drop_entry(key)
            # A kept version outlives its bytes, as redis's meta key does.
            kept = (
                entry.fingerprint
                if entry.holds is Holds.BYTES_AND_VERSION
                else None
            )
            if kept:
                self._put_version(key, kept)
        if kept:
            await self._evict()
        return None

    async def set(
        self,
        key: str,
        data: bytes,
        fingerprint: str | None = None,
        ttl: int | None = None,
    ) -> None:
        # Stamped before waiting on the lock: bytes read before an
        # invalidation are stale even when the lock was granted after it.
        stamp = self._invalidation.enter(key)
        try:
            async with self._lock_for(key):
                if self._invalidation.stale(key, stamp):
                    return
                self._drop_entry(key)
                entry = CacheEntry(
                    size=len(data),
                    cached_at=int(time.time()),
                    fingerprint=fingerprint or None,
                    ttl=ttl,
                )
                self._entries[key] = entry
                self._store.files[key] = data
                self._cache_size += entry.size
        finally:
            self._invalidation.leave(key)
        await self._evict()

    async def remove(self, key: str) -> None:
        async with self._lock_for(key):
            # Advanced here, when the removal takes effect, not when it
            # was called: a writer queued behind it took its stamp before
            # this ran, and only a later invalidation tells it its bytes
            # predate the removal. Per key: a fill of another key still
            # hashing is not this removal's business.
            self._invalidation.invalidate(key)
            self._drop_entry(key)
        self._discard_lock(key)

    async def exists(self, key: str | PathSpec) -> bool:
        """Whether the cache holds a live entry for ``key``.

        The cache's own key test, which a path answers by its mount path.

        Args:
            key (str | PathSpec): the entry's key.
        """
        entry = self._entries.get(
            key if isinstance(key, str) else key.mount_path
        )
        return entry is not None and entry.has_bytes and not entry.expired

    async def fingerprint(self, key: str) -> str | None:
        entry = self._entries.get(key)
        return entry.fingerprint if entry is not None else None

    async def keep_fingerprints(self, fingerprints: dict[str, str]) -> None:
        for key, fingerprint in fingerprints.items():
            await self._set_version(key, fingerprint)

    async def _set_version(self, key: str, fingerprint: str) -> None:
        stamp = self._invalidation.enter(key)
        try:
            async with self._lock_for(key):
                if self._invalidation.stale(key, stamp):
                    return
                entry = self._entries.get(key)
                if entry is not None and entry.has_bytes and not entry.expired:
                    if entry.fingerprint == fingerprint:
                        entry.holds = Holds.BYTES_AND_VERSION
                    return
                self._drop_entry(key)
                self._put_version(key, fingerprint)
        finally:
            self._invalidation.leave(key)
        await self._evict()

    def _put_version(self, key: str, fingerprint: str) -> None:
        version = CacheEntry(
            size=len(key) + len(fingerprint),
            cached_at=int(time.time()),
            fingerprint=fingerprint,
            holds=Holds.VERSION,
        )
        self._entries[key] = version
        self._cache_size += version.size

    async def is_fresh(self, key: str, remote_fingerprint: str) -> bool:
        entry = self._entries.get(key)
        if entry is None or not entry.has_bytes:
            return False
        # An entry that carries no token verifies against nothing, and
        # says so here rather than relying on the caller to ask only when
        # it holds one. Without the first clause a caller arriving with
        # no remote token compares None to None and is told the copy is
        # fresh; the redis store, whose meta key is simply absent, would
        # answer False for the same pair.
        return (
            entry.fingerprint is not None
            and entry.fingerprint == remote_fingerprint
        )

    async def is_unbounded(self, key: str) -> bool:
        entry = self._entries.get(key)
        return entry is not None and entry.has_bytes and entry.ttl is None

    async def clear(self) -> None:
        self._invalidation.invalidate_all()
        async with self._clear_lock:
            self._entries.clear()
            self._store.files.clear()
            self._cache_size = 0
            self._clear_locks()

    async def evict_prefix(
        self, prefix: str, *, excluded: tuple[str, ...] = ()
    ) -> None:
        # Before the removals below: a fill in flight under the prefix has
        # no entry yet, so only its registration can name it.
        self._invalidation.invalidate_prefix(prefix, excluded)
        for key in [
            k
            for k in list(self._entries)
            if k.startswith(prefix)
            and not any(under_path(k, p) for p in excluded)
        ]:
            await self.remove(key)

    def evict_paths(self, paths: Iterable[str]) -> None:
        for key in paths:
            self._invalidation.invalidate(key)
            self._drop_entry(key)

    def _drop_entry(self, key: str) -> None:
        entry = self._entries.pop(key, None)
        if entry is not None:
            self._cache_size -= entry.size
        self._store.files.pop(key, None)

    async def _evict(self) -> None:
        while self._cache_size > self._cache_limit and self._entries:
            evicted_key = next(iter(self._entries))
            async with self._lock_for(evicted_key):
                if evicted_key not in self._entries:
                    continue
                self._drop_entry(evicted_key)
            self._discard_lock(evicted_key)

    @property
    def cache_size(self) -> int:
        return self._cache_size

    @property
    def cache_entries(self) -> int:
        return len(self._entries)

    @property
    def cache_limit(self) -> int:
        return self._cache_limit
