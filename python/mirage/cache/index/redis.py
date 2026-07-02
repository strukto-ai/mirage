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

from datetime import datetime, timezone

try:
    from redis.asyncio import Redis
except ImportError as _err:
    raise ImportError("RedisIndexCacheStore requires the 'redis' extra. "
                      "Install with: pip install mirage-ai[redis]") from _err

from mirage.cache.index.config import (IndexEntry, ListResult, LookupResult,
                                       LookupStatus)
from mirage.cache.index.store import IndexCacheStore
from mirage.core.timeutil import to_iso_z

ENTRY_PREFIX = "mirage:idx:entry:"
CHILDREN_PREFIX = "mirage:idx:children:"


class RedisIndexCacheStore(IndexCacheStore):
    """Redis-backed index cache for remote resource metadata.

    Stores IndexEntry objects as JSON strings and directory children as
    Redis lists. Directory TTL is managed via native Redis key expiration.
    All writes within set_dir are batched in a single pipeline for efficiency.

    Multiple stores can share one Redis server by using distinct key_prefix
    values (e.g. "gdrive:", "s3:"). The full key layout is::

        {key_prefix}mirage:idx:entry:{resource_path}     -> JSON string
        {key_prefix}mirage:idx:children:{resource_path}  -> Redis list

    Args:
        ttl (float): Default time-to-live in seconds for directory listings.
        url (str): Redis connection URL, used when *client* is not provided.
        client (Redis | None): Pre-existing async Redis client. When given,
            the store will not close it on ``close()``.
        key_prefix (str): Namespace prefix prepended to every Redis key,
            allowing multiple stores to coexist on the same server.
    """

    def __init__(
        self,
        ttl: float = 600,
        url: str = "redis://localhost:6379/0",
        client: Redis | None = None,
        key_prefix: str = "",
    ) -> None:
        super().__init__()
        self._ttl = ttl
        self._client = client or Redis.from_url(url, decode_responses=True)
        self._owns_client = client is None
        p = key_prefix or ""
        self._entry_prefix = f"{p}{ENTRY_PREFIX}"
        self._children_prefix = f"{p}{CHILDREN_PREFIX}"

    def _entry_key(self, resource_path: str) -> str:
        return f"{self._entry_prefix}{resource_path}"

    def _children_key(self, resource_path: str) -> str:
        return f"{self._children_prefix}{resource_path}"

    async def get(self, resource_path: str) -> LookupResult:
        raw = await self._client.get(self._entry_key(resource_path))
        if raw is None:
            return LookupResult(status=LookupStatus.NOT_FOUND)
        entry = IndexEntry.model_validate_json(raw)
        return LookupResult(entry=entry)

    async def put(self, resource_path: str, entry: IndexEntry) -> None:
        if not entry.index_time:
            entry = entry.model_copy(
                update={"index_time": to_iso_z(datetime.now(timezone.utc))})
        await self._client.set(self._entry_key(resource_path),
                               entry.model_dump_json())

    async def list_dir(self, resource_path: str) -> ListResult:
        key = self._children_key(resource_path)
        exists = await self._client.exists(key)
        if not exists:
            return ListResult(status=LookupStatus.NOT_FOUND)
        ttl_remaining = await self._client.ttl(key)
        if ttl_remaining == -2:
            return ListResult(status=LookupStatus.EXPIRED)
        raw = await self._client.lrange(key, 0, -1)
        return ListResult(entries=raw)

    async def set_dir(
        self,
        resource_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        now = datetime.now(timezone.utc)
        now_iso = to_iso_z(now)
        prefix = "/" if resource_path == "/" else resource_path + "/"

        pipe = self._client.pipeline()
        child_keys: list[str] = []
        for name, entry in entries:
            full_path = prefix + name
            if not entry.index_time:
                entry = entry.model_copy(update={"index_time": now_iso})
            pipe.set(self._entry_key(full_path), entry.model_dump_json())
            child_keys.append(full_path)

        children_key = self._children_key(resource_path)
        pipe.delete(children_key)
        if child_keys:
            pipe.rpush(children_key, *child_keys)

        if expired_at:
            ttl_seconds = max(1, int((expired_at - now).total_seconds()))
        else:
            ttl_seconds = max(1, int(self._ttl))
        pipe.expire(children_key, ttl_seconds)

        await pipe.execute()

    async def invalidate_dir(self, resource_path: str) -> None:
        children_key = f"{self._children_prefix}{resource_path}"
        child_paths = await self._client.lrange(children_key, 0, -1)
        pipe = self._client.pipeline()
        for child in child_paths:
            pipe.delete(self._entry_key(child))
        pipe.delete(children_key)
        await pipe.execute()

    async def clear(self) -> None:
        cursor = 0
        while True:
            cursor, keys = await self._client.scan(
                cursor, match=f"{self._entry_prefix}*", count=500)
            if keys:
                await self._client.delete(*keys)
            if cursor == 0:
                break
        cursor = 0
        while True:
            cursor, keys = await self._client.scan(
                cursor, match=f"{self._children_prefix}*", count=500)
            if keys:
                await self._client.delete(*keys)
            if cursor == 0:
                break

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
