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

from mirage.cache.file.entry import CacheEntry
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.file.utils import default_fingerprint, parse_limit
from mirage.cache.lock import KeyLockMixin
from mirage.resource.ram import RAMResource


class RAMFileCacheStore(RAMResource, FileCacheMixin, KeyLockMixin):
    """RAMResource with LRU cache tracking.

    Data lives in inherited _store.files (RAMStore).
    _entries tracks LRU metadata only.
    All RAM commands (cat, grep, head, ...) inherited.
    """

    def __init__(
        self,
        cache_limit: str | int = "512MB",
        max_drain_bytes: int | None = None,
    ) -> None:
        super().__init__()
        self._cache_limit: int = parse_limit(cache_limit)
        self._cache_size: int = 0
        self._entries: OrderedDict[str, CacheEntry] = OrderedDict()
        self._drain_tasks: dict[str, asyncio.Task] = {}
        self._clear_lock: asyncio.Lock = asyncio.Lock()
        self.max_drain_bytes: int | None = max_drain_bytes

    async def get(self, key: str) -> bytes | None:
        async with self._lock_for(key):
            entry = self._entries.get(key)
            if entry is None:
                return None
            if entry.expired:
                self._cache_size -= entry.size
                del self._entries[key]
                self._store.files.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return self._store.files.get(key)

    async def set(self,
                  key: str,
                  data: bytes,
                  fingerprint: str | None = None,
                  ttl: int | None = None) -> None:
        async with self._lock_for(key):
            if key in self._entries:
                self._cache_size -= self._entries[key].size
                del self._entries[key]
            if fingerprint is None:
                fingerprint = default_fingerprint(data)
            entry = CacheEntry(
                size=len(data),
                cached_at=int(time.time()),
                fingerprint=fingerprint,
                ttl=ttl,
            )
            self._entries[key] = entry
            self._store.files[key] = data
            self._cache_size += entry.size
        await self._evict()

    async def add(self,
                  key: str,
                  data: bytes,
                  fingerprint: str | None = None,
                  ttl: int | None = None) -> bool:
        async with self._lock_for(key):
            existing = self._entries.get(key)
            if existing is not None and not existing.expired:
                return False
            if key in self._entries:
                self._cache_size -= self._entries[key].size
                del self._entries[key]
            if fingerprint is None:
                fingerprint = default_fingerprint(data)
            entry = CacheEntry(
                size=len(data),
                cached_at=int(time.time()),
                fingerprint=fingerprint,
                ttl=ttl,
            )
            self._entries[key] = entry
            self._store.files[key] = data
            self._cache_size += entry.size
        await self._evict()
        return True

    async def remove(self, key: str) -> None:
        async with self._lock_for(key):
            task = self._drain_tasks.pop(key, None)
            if task:
                task.cancel()
            if key in self._entries:
                self._cache_size -= self._entries[key].size
                del self._entries[key]
                self._store.files.pop(key, None)
        self._discard_lock(key)

    async def exists(self, key: str) -> bool:
        entry = self._entries.get(key)
        return entry is not None and not entry.expired

    async def is_fresh(self, key: str, remote_fingerprint: str) -> bool:
        entry = self._entries.get(key)
        if entry is None:
            return False
        return entry.fingerprint == remote_fingerprint

    async def clear(self) -> None:
        async with self._clear_lock:
            for task in self._drain_tasks.values():
                task.cancel()
            self._drain_tasks.clear()
            self._entries.clear()
            self._store.files.clear()
            self._cache_size = 0
            self._clear_locks()

    def evict_paths(self, paths: Iterable[str]) -> None:
        for key in paths:
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
                evicted = self._entries.pop(evicted_key)
                self._cache_size -= evicted.size
                self._store.files.pop(evicted_key, None)
            self._discard_lock(evicted_key)

    @property
    def cache_size(self) -> int:
        return self._cache_size

    @property
    def cache_limit(self) -> int:
        return self._cache_limit
