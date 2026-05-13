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

from mirage.cache.file.mixin import FileCacheMixin
from mirage.cache.file.utils import default_fingerprint, parse_limit
from mirage.resource.redis.redis import RedisResource


class RedisFileCacheStore(RedisResource, FileCacheMixin):

    def __init__(
        self,
        cache_limit: str | int = "512MB",
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:cache:",
        max_drain_bytes: int | None = None,
    ) -> None:
        super().__init__(url=url, key_prefix=key_prefix)
        self._cache_limit: int = parse_limit(cache_limit)
        self._cache_client = self._store._client
        self._data_prefix = f"{key_prefix}data:"
        self._meta_prefix = f"{key_prefix}meta:"
        self.max_drain_bytes: int | None = max_drain_bytes

    async def get(self, key: str) -> bytes | None:
        return await self._cache_client.get(f"{self._data_prefix}{key}")

    async def set(
        self,
        key: str,
        data: bytes,
        fingerprint: str | None = None,
        ttl: int | None = None,
    ) -> None:
        if fingerprint is None:
            fingerprint = default_fingerprint(data)
        pipe = self._cache_client.pipeline()
        dk = f"{self._data_prefix}{key}"
        mk = f"{self._meta_prefix}{key}"
        pipe.set(dk, data)
        pipe.set(mk, fingerprint)
        if ttl is not None:
            pipe.expire(dk, ttl)
            pipe.expire(mk, ttl)
        await pipe.execute()

    async def add(
        self,
        key: str,
        data: bytes,
        fingerprint: str | None = None,
        ttl: int | None = None,
    ) -> bool:
        dk = f"{self._data_prefix}{key}"
        exists = await self._cache_client.exists(dk)
        if exists:
            return False
        await self.set(key, data, fingerprint=fingerprint, ttl=ttl)
        return True

    async def remove(self, key: str) -> None:
        pipe = self._cache_client.pipeline()
        pipe.delete(f"{self._data_prefix}{key}")
        pipe.delete(f"{self._meta_prefix}{key}")
        await pipe.execute()

    async def exists(self, key: str) -> bool:
        return bool(await
                    self._cache_client.exists(f"{self._data_prefix}{key}"))

    async def is_fresh(self, key: str, remote_fingerprint: str) -> bool:
        fp = await self._cache_client.get(f"{self._meta_prefix}{key}")
        if fp is None:
            return False
        if isinstance(fp, bytes):
            fp = fp.decode()
        return fp == remote_fingerprint

    async def clear(self) -> None:
        for pattern in (
                f"{self._data_prefix}*",
                f"{self._meta_prefix}*",
        ):
            keys: list = []
            async for k in self._cache_client.scan_iter(pattern):
                keys.append(k)
            if keys:
                await self._cache_client.delete(*keys)

    def evict_paths(self, paths: Iterable[str]) -> None:
        # No-op: Redis cache holds nothing restored from the snapshot
        # (only RAM caches are repopulated by _restore_cache), and the
        # snapshot load path is sync so we cannot await redis deletes
        # here. If a caller needs to drop live Redis-cached entries, use
        # await self.remove(key) per path from an async context.
        pass

    @property
    def cache_size(self) -> int:
        return 0

    @property
    def cache_limit(self) -> int:
        return self._cache_limit
