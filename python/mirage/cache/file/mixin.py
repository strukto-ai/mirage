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

from collections.abc import Iterable


class FileCacheMixin:
    """LRU file cache mixin for resources.

    Adds cache tracking (sizes, fingerprints, TTL, LRU order)
    on top of any resource. Data lives in the resource's storage —
    subclass implements the cache methods using resource's store.
    """

    async def get(self, key: str) -> bytes | None:
        raise NotImplementedError

    async def set(self,
                  key: str,
                  data: bytes,
                  fingerprint: str | None = None,
                  ttl: int | None = None) -> None:
        raise NotImplementedError

    async def add(self,
                  key: str,
                  data: bytes,
                  fingerprint: str | None = None,
                  ttl: int | None = None) -> bool:
        raise NotImplementedError

    async def remove(self, key: str) -> None:
        raise NotImplementedError

    async def exists(self, key: str) -> bool:
        raise NotImplementedError

    async def is_fresh(self, key: str, remote_fingerprint: str) -> bool:
        raise NotImplementedError

    async def clear(self) -> None:
        raise NotImplementedError

    def evict_paths(self, paths: Iterable[str]) -> None:
        """Synchronously evict the given keys from the cache.

        Load-time helper invoked from ``Workspace.load`` (sync) to drop
        snapshot-restored bytes for paths the caller wants to re-fetch
        live. Backends whose state cannot be mutated synchronously
        (e.g. Redis) override this as a no-op.

        Args:
            paths (Iterable[str]): Cache keys to drop.
        """
        raise NotImplementedError

    async def all_cached(self, keys: list[str]) -> bool:
        for k in keys:
            if not await self.exists(k):
                return False
        return True

    async def multi_get(self, keys: list[str]) -> list[bytes | None]:
        return [await self.get(k) for k in keys]

    async def multi_set(
        self,
        items: list[tuple[str, bytes]],
        fingerprint: str | None = None,
        ttl: int | None = None,
    ) -> None:
        for key, data in items:
            await self.set(key, data, fingerprint=fingerprint, ttl=ttl)

    @property
    def cache_size(self) -> int:
        raise NotImplementedError

    @property
    def cache_limit(self) -> int:
        raise NotImplementedError
