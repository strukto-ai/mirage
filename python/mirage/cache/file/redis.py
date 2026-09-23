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
from collections.abc import Iterable
from importlib.resources import files
from typing import Any

from mirage.cache.file.mixin import FileCacheMixin, validate_max_drain_bytes
from mirage.cache.file.utils import glob_escape, parse_limit
from mirage.cache.invalidation import Invalidation
from mirage.vfs.redis.redis import RedisVFS

# Shipped next to this module; byte-identical to the TypeScript add.lua.
ADD_LUA = (files("mirage.cache.file") / "add.lua").read_text(encoding="utf-8")


class RedisFileCacheStore(RedisVFS, FileCacheMixin):

    def __init__(
        self,
        cache_limit: str | int = "512MB",
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:cache:",
        max_drain_bytes: int | None = None,
    ) -> None:
        parsed_limit = parse_limit(cache_limit)
        validate_max_drain_bytes(parsed_limit, max_drain_bytes)
        super().__init__(url=url, key_prefix=key_prefix)
        # Advisory only: unlike the RAM store there is no client-side
        # LRU, so nothing evicts on overflow. Cap memory on the Redis
        # server instead (maxmemory + maxmemory-policy allkeys-lru) to
        # approximate the RAM store's eviction behavior.
        self._cache_limit: int = parsed_limit
        self._cache_client = self._store._client
        self._data_prefix = f"{key_prefix}data:"
        self._meta_prefix = f"{key_prefix}meta:"
        self.max_drain_bytes: int | None = max_drain_bytes
        # Local invalidation discards a fill whose key was dropped while
        # it was in flight. Dormant on this host: nothing suspends between
        # the stamp and the check here (see `set`), so it is the shared
        # cross-language contract and a guard against a future await
        # rather than a window that can currently open.
        self._invalidation = Invalidation()
        self._drain_tasks: dict[str, asyncio.Task[Any]] = {}
        self._add = self._cache_client.register_script(ADD_LUA)

    def _data_key(self, key: str) -> str:
        return f"{self._data_prefix}{key}"

    def _meta_key(self, key: str) -> str:
        return f"{self._meta_prefix}{key}"

    async def get(self, key: str) -> bytes | None:
        return await self._cache_client.get(self._data_key(key))

    async def set(
        self,
        key: str,
        data: bytes,
        fingerprint: str | None = None,
        ttl: int | None = None,
    ) -> None:
        stamp = self._invalidation.enter(key)
        try:
            if self._invalidation.stale(key, stamp):
                return
            pipe = self._cache_client.pipeline()
            dk = self._data_key(key)
            mk = self._meta_key(key)
            pipe.set(dk, data)
            # Deleted, not left alone: redis expires the two keys
            # independently and a re-set of an entry that carried a token
            # would otherwise leave the old meta key describing the new
            # bytes, which `is_fresh` would read as fresh.
            if fingerprint:
                pipe.set(mk, fingerprint)
            else:
                pipe.delete(mk)
            if ttl is not None:
                pipe.expire(dk, ttl)
                if fingerprint:
                    pipe.expire(mk, ttl)
            await pipe.execute()
        finally:
            self._invalidation.leave(key)

    async def add(
        self,
        key: str,
        data: bytes,
        fingerprint: str | None = None,
        ttl: int | None = None,
    ) -> bool:
        stamp = self._invalidation.enter(key)
        try:
            if self._invalidation.stale(key, stamp):
                return False
            # The background drain deliberately uses insert-only
            # semantics: an older drain finishing late must not overwrite
            # a newer cache fill. add.lua keeps the existence check, bytes,
            # fingerprint and TTL in one Redis execution so shared-cache
            # writers cannot interleave.
            inserted = await self._add(
                keys=[self._data_key(key),
                      self._meta_key(key)],
                args=[
                    data, fingerprint or "", "" if ttl is None else str(ttl)
                ],
            )
            return bool(inserted)
        finally:
            self._invalidation.leave(key)

    async def remove(self, key: str) -> None:
        self._invalidation.invalidate(key)
        task = self._drain_tasks.pop(key, None)
        if task:
            task.cancel()
        pipe = self._cache_client.pipeline()
        pipe.delete(self._data_key(key))
        pipe.delete(self._meta_key(key))
        await pipe.execute()

    async def exists(self, key: str) -> bool:
        return bool(await self._cache_client.exists(self._data_key(key)))

    async def is_fresh(self, key: str, remote_fingerprint: str) -> bool:
        fp = await self._cache_client.get(self._meta_key(key))
        if fp is None:
            return False
        if isinstance(fp, bytes):
            fp = fp.decode()
        return fp == remote_fingerprint

    async def is_unbounded(self, key: str) -> bool:
        # Redis answers this natively and distinguishes the two cases
        # that matter: -1 is present with no expiry, -2 is absent.
        return await self._cache_client.ttl(self._data_key(key)) == -1

    async def clear(self) -> None:
        self._invalidation.invalidate_all()
        for task in self._drain_tasks.values():
            task.cancel()
        self._drain_tasks.clear()
        for pattern in (
                f"{self._data_prefix}*",
                f"{self._meta_prefix}*",
        ):
            keys: list[Any] = []
            async for k in self._cache_client.scan_iter(pattern):
                keys.append(k)
            if keys:
                await self._cache_client.delete(*keys)

    async def evict_prefix(self, prefix: str) -> None:
        self._invalidation.invalidate_all()
        for key in [k for k in self._drain_tasks if k.startswith(prefix)]:
            task = self._drain_tasks.pop(key)
            task.cancel()
        escaped = glob_escape(prefix)
        for base in (self._data_prefix, self._meta_prefix):
            keys: list[Any] = []
            async for k in self._cache_client.scan_iter(f"{base}{escaped}*"):
                keys.append(k)
            if keys:
                await self._cache_client.delete(*keys)

    async def close(self) -> None:
        await self._store.close()

    def evict_paths(self, paths: Iterable[str]) -> None:
        # No-op: Redis cache holds nothing restored from the snapshot
        # (only RAM caches are repopulated by _restore_cache), and the
        # snapshot load path is sync so we cannot await redis deletes
        # here. If a caller needs to drop live Redis-cached entries, use
        # await self.remove(key) per path from an async context.
        pass

    @property
    def cache_size(self) -> int | None:
        # Size lives in the redis server and is not tracked client-side.
        return None

    @property
    def cache_limit(self) -> int:
        return self._cache_limit
