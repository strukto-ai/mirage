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
from mirage.types import PathSpec
from mirage.utils.key_prefix import under_path
from mirage.vfs.redis.redis import RedisVFS

# Shipped next to this module; byte-identical to the TypeScript add.lua.
ADD_LUA = (files("mirage.cache.file") / "add.lua").read_text(encoding="utf-8")
VERSION_LUA = (files("mirage.cache.file") / "version.lua").read_text(
    encoding="utf-8"
)

# Hash slots one SCAN call visits. A prefix drop walks the whole server,
# so this sets both the round trips (dbsize / SCAN_COUNT) and how long
# each call holds the server: about 1-2 ms at 1000, against the 10 ms
# slowlog default. The client default of 10 made one drop at 1M server
# keys take 191k round trips.
SCAN_COUNT = 1000

# Keys one DEL names. Freeing memory is what a DEL costs, and a body has
# no size bound: one DEL per page freed up to SCAN_COUNT bodies at once,
# about 10 ms for 100 bodies of 512 KB and 1.5 ms for 10. A page goes out
# as one pipeline of DELs this size, so it is still one round trip.
DEL_BATCH = 10

# Keys per MGET of versions and per pipeline of kept versions.
KEY_BATCH = 1000

# Seconds a version kept without its bytes lives (raise-only over bytes).
VERSION_TTL = 86_400


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
        self._entry_pattern = f"{glob_escape(key_prefix)}[dm][ae]ta:"
        self.max_drain_bytes: int | None = max_drain_bytes
        # Local invalidation discards a fill whose key was dropped while
        # it was in flight. Dormant on this host: nothing suspends between
        # the stamp and the check here (see `set`), so it is the shared
        # cross-language contract and a guard against a future await
        # rather than a window that can currently open.
        self._invalidation = Invalidation()
        self._drain_tasks: dict[str, asyncio.Task[Any]] = {}
        self._add = self._cache_client.register_script(ADD_LUA)
        self._version = self._cache_client.register_script(VERSION_LUA)

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
                keys=[self._data_key(key), self._meta_key(key)],
                args=[
                    data,
                    fingerprint or "",
                    "" if ttl is None else str(ttl),
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

    async def exists(self, key: str | PathSpec) -> bool:
        """Whether the cache holds an entry for ``key``.

        The cache's own key test, which a path answers by its mount path.

        Args:
            key (str | PathSpec): the entry's key.
        """
        name = key if isinstance(key, str) else key.mount_path
        return bool(await self._cache_client.exists(self._data_key(name)))

    async def fingerprint(self, key: str) -> str | None:
        fp = await self._cache_client.get(self._meta_key(key))
        if fp is None:
            return None
        return fp.decode() if isinstance(fp, bytes) else str(fp)

    async def fingerprints(self, keys: list[str]) -> list[str | None]:
        out: list[str | None] = []
        for start in range(0, len(keys), KEY_BATCH):
            got = await self._cache_client.mget(
                [self._meta_key(k) for k in keys[start : start + KEY_BATCH]]
            )
            out.extend(
                None
                if fp is None
                else (fp.decode() if isinstance(fp, bytes) else str(fp))
                for fp in got
            )
        return out

    async def set_versions(self, versions: dict[str, str]) -> None:
        keys = list(versions)
        for start in range(0, len(keys), KEY_BATCH):
            batch = keys[start : start + KEY_BATCH]
            stamps = {key: self._invalidation.enter(key) for key in batch}
            try:
                live = [
                    key
                    for key in batch
                    if not self._invalidation.stale(key, stamps[key])
                ]
                # A scripted pipeline costs a SCRIPT EXISTS round trip first.
                pipe = (
                    self._cache_client.pipeline(transaction=False)
                    if len(live) > 1
                    else None
                )
                for key in live:
                    await self._version(
                        keys=[self._data_key(key), self._meta_key(key)],
                        args=[versions[key], VERSION_TTL],
                        client=pipe,
                    )
                if pipe is not None:
                    await pipe.execute()
            finally:
                for key in batch:
                    self._invalidation.leave(key)

    async def is_fresh(self, key: str, remote_fingerprint: str) -> bool:
        pipe = self._cache_client.pipeline(transaction=False)
        pipe.exists(self._data_key(key))
        pipe.get(self._meta_key(key))
        held, fp = await pipe.execute()
        # A version kept without its bytes vouches for no bytes.
        if not held or fp is None:
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
        await self._drop_matching("")

    async def evict_prefix(
        self, prefix: str, *, excluded: tuple[str, ...] = ()
    ) -> None:
        self._invalidation.invalidate_prefix(prefix, excluded)
        for key in [
            k
            for k in self._drain_tasks
            if k.startswith(prefix)
            and not any(under_path(k, p) for p in excluded)
        ]:
            task = self._drain_tasks.pop(key)
            task.cancel()
        await self._drop_matching(prefix, excluded)

    async def _drop_matching(
        self, prefix: str, excluded: tuple[str, ...] = ()
    ) -> None:
        """Delete the data and meta keys of every entry under ``prefix``.

        One SCAN pass covers both kinds, and each page is deleted as it
        arrives, in DELs of at most ``DEL_BATCH`` keys, so no single call
        holds the server for the whole subtree. Deleting keys a SCAN
        already returned is safe: SCAN still returns every key present for
        the whole iteration.

        Args:
            prefix (str): cache-key prefix to drop; empty drops all.
            excluded (tuple[str, ...]): roots whose keys stay.
        """
        match = f"{self._entry_pattern}{glob_escape(prefix)}*"
        cursor = 0
        while True:
            cursor, page = await self._cache_client.scan(
                cursor, match=match, count=SCAN_COUNT
            )
            doomed = [k for k in page if self._owned(k, excluded)]
            if doomed:
                pipe = self._cache_client.pipeline(transaction=False)
                for start in range(0, len(doomed), DEL_BATCH):
                    pipe.delete(*doomed[start : start + DEL_BATCH])
                await pipe.execute()
            if cursor == 0:
                return

    def _owned(self, raw: bytes | str, excluded: tuple[str, ...]) -> bool:
        """Whether a SCAN match is this cache's entry and not excluded.

        The MATCH class ``[dm][ae]ta:`` also admits ``deta:`` and
        ``mata:``, which are not the cache's. A shared server may hold any
        bytes as a key, so the name is decoded without failing on bytes
        that are not UTF-8; the DEL still names the raw key.

        Args:
            raw (bytes | str): the key SCAN returned.
            excluded (tuple[str, ...]): roots whose keys stay.
        """
        name = (
            raw.decode(errors="surrogateescape")
            if isinstance(raw, bytes)
            else raw
        )
        for base in (self._data_prefix, self._meta_prefix):
            if name.startswith(base):
                key = name[len(base) :]
                return not any(under_path(key, p) for p in excluded)
        return False

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
