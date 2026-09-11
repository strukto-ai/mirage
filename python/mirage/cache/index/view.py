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

from collections.abc import Callable
from datetime import datetime

from mirage.cache.file.io import mutation_lock
from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.index.config import (IndexEntry, ListResult, LookupResult,
                                       LookupStatus)
from mirage.cache.index.store import IndexCacheStore


class IndexView(IndexCacheStore):
    """A mount-owned view over a resource's metadata index.

    Backend calls retain this view across awaits. Ownership is checked under
    the same lock that retires mount cache state, so late metadata writes
    cannot refill a replacement mount's index.
    """

    def __init__(self, store: IndexCacheStore, cache: FileCacheMixin,
                 prefix: str, owns: Callable[[str], bool]) -> None:
        super().__init__()
        self._store = store
        self._cache = cache
        self._prefix = prefix or "/"
        self._owns = owns

    async def get(self, resource_path: str) -> LookupResult:
        # A lookup may flush a queued snapshot, so reads share the write fence.
        async with mutation_lock(self._cache):
            if not self._owns(resource_path):
                return LookupResult(status=LookupStatus.NOT_FOUND)
            result = await self._store.get(resource_path)
            return result if self._owns(resource_path) else LookupResult(
                status=LookupStatus.NOT_FOUND)

    async def list_dir(self, resource_path: str) -> ListResult:
        async with mutation_lock(self._cache):
            if not self._owns(resource_path):
                return ListResult(status=LookupStatus.NOT_FOUND)
            result = await self._store.list_dir(resource_path)
            if not self._owns(resource_path):
                return ListResult(status=LookupStatus.NOT_FOUND)
            if result.entries is None:
                return result
            return result.model_copy(update={
                "entries":
                [path for path in result.entries if self._owns(path)]
            })

    async def put(self, resource_path: str, entry: IndexEntry) -> None:
        async with mutation_lock(self._cache):
            if self._owns(resource_path):
                await self._store.put(resource_path, entry)

    async def set_dir(self,
                      resource_path: str,
                      entries: list[tuple[str, IndexEntry]],
                      expired_at: datetime | None = None) -> None:
        async with mutation_lock(self._cache):
            if self._owns(resource_path):
                prefix = resource_path.rstrip("/") + "/"
                owned = [(name, entry) for name, entry in entries
                         if self._owns(prefix + name)]
                await self._store.set_dir(resource_path, owned, expired_at)

    def seed(self, entries: dict[str, IndexEntry],
             children: dict[str, list[str]], expires_at: datetime) -> None:
        if not self._owns(self._prefix):
            return
        self._store.seed(
            {
                path: entry
                for path, entry in entries.items() if self._owns(path)
            }, {
                path: [key for key in keys if self._owns(key)]
                for path, keys in children.items() if self._owns(path)
            }, expires_at)

    async def entries(self) -> dict[str, IndexEntry]:
        async with mutation_lock(self._cache):
            if not self._owns(self._prefix):
                return {}
            entries = await self._store.entries()
            return {
                path: entry
                for path, entry in entries.items() if self._owns(path)
            }

    async def invalidate_dir(self, resource_path: str) -> None:
        async with mutation_lock(self._cache):
            if self._owns(resource_path):
                await self._store.invalidate_dir(resource_path)

    async def invalidate_prefix(self, resource_path: str) -> None:
        async with mutation_lock(self._cache):
            if self._owns(resource_path):
                await self._store.invalidate_prefix(resource_path)

    async def invalidate(self) -> None:
        async with mutation_lock(self._cache):
            if self._owns(self._prefix):
                await self._store.invalidate()

    async def clear(self) -> None:
        await self.invalidate_prefix(self._prefix)
