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
from datetime import datetime, timedelta, timezone

try:
    from redis.asyncio import Redis
except ImportError as _err:
    raise ImportError("RedisIndexCacheStore requires the 'redis' extra. "
                      "Install with: pip install mirage-ai[redis]") from _err

from mirage.cache.index.config import (IndexDirectory, IndexEntry, ListResult,
                                       LookupResult, LookupStatus)
from mirage.cache.index.constants import (CHILDREN_PREFIX, ENTRY_PREFIX,
                                          GENERATION_KEY)
from mirage.cache.index.store import IndexCacheStore
from mirage.core.timeutil import to_iso_z
from mirage.utils.ids import uuid7
from mirage.utils.key_prefix import under_path


def _text(value: str | bytes) -> str:
    return value.decode() if isinstance(value, bytes) else value


def _glob_escape(value: str) -> str:
    """Escape redis MATCH metacharacters in a literal path.

    A path may legally contain ``*?[]``, and SCAN's pattern is a glob, so
    an unescaped path would match keys it does not name. The escaping is
    a narrowing optimization only; the caller still filters the results
    at a path boundary.

    Args:
        value (str): A literal path to embed in a MATCH pattern.
    """
    out: list[str] = []
    for char in value:
        if char in "*?[]\\":
            out.append("\\")
        out.append(char)
    return "".join(out)


class RedisIndexCacheStore(IndexCacheStore):
    """Redis-backed index cache for remote VFS metadata.

    Stores IndexEntry objects as JSON strings and directory children as
    JSON records holding children and expiry, including empty listings.
    Like RAM, stale records remain until explicitly cleared or invalidated by
    path, so expiry is distinguishable from absence. Redis eviction may still
    remove records; size limits belong to the server, not this store.
    All writes within set_dir are batched in a single pipeline for efficiency.

    Multiple stores can share one Redis server by using distinct key_prefix
    values (e.g. "gdrive:", "s3:"). The full key layout is::

        {key_prefix}mirage:idx:entry:{vfs_path} -> IndexEntry JSON
        {key_prefix}mirage:idx:directory:{vfs_path} -> IndexDirectory JSON

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
        self._client = (client if client is not None else Redis.from_url(
            url, decode_responses=True))
        self._owns_client = client is None
        self._pending_seeds: list[tuple[dict[str, IndexEntry],
                                        dict[str, list[str]], datetime]] = []
        self._seed_lock = asyncio.Lock()
        self._generation_tasks: dict[str, asyncio.Task[str]] = {}
        p = key_prefix or ""
        self._entry_prefix = f"{p}{ENTRY_PREFIX}"
        self._children_prefix = f"{p}{CHILDREN_PREFIX}"
        self._generation_key = f"{p}{GENERATION_KEY}"
        self._directory_generation_prefix = f"{self._generation_key}:"

    def _entry_key(self, vfs_path: str) -> str:
        return f"{self._entry_prefix}{vfs_path}"

    def _children_key(self, vfs_path: str) -> str:
        return f"{self._children_prefix}{vfs_path}"

    def seed(self, entries: dict[str, IndexEntry],
             children: dict[str, list[str]], expires_at: datetime) -> None:
        now_iso = to_iso_z(datetime.now(timezone.utc))
        self._pending_seeds.append(({
            path:
            entry if entry.index_time else entry.model_copy(
                update={"index_time": now_iso})
            for path, entry in entries.items()
        }, {
            path: list(keys)
            for path, keys in children.items()
        }, expires_at))

    async def _generation(self, key: str) -> str:
        task = self._generation_tasks.get(key)
        if task is None or task.done():

            async def initialize() -> str:
                current = await self._client.get(key)
                if current is not None:
                    return _text(current)
                generation = uuid7()
                await self._client.set(key, generation, nx=True)
                # Never adopt a later token: a concurrent invalidation may
                # have replaced it. Losing safely costs one extra refill.
                return generation

            def finished(completed: asyncio.Task[str]) -> None:
                if self._generation_tasks.get(key) is completed:
                    self._generation_tasks.pop(key, None)
                # Retrieve failures even if every waiter was cancelled.
                if not completed.cancelled():
                    completed.exception()

            task = asyncio.create_task(initialize())
            self._generation_tasks[key] = task
            task.add_done_callback(finished)
        # Parallel directory writes in one store share token initialization;
        # cancellation of one waiter must not cancel the others.
        return await asyncio.shield(task)

    async def _directory_generations(self,
                                     directories: set[str]) -> dict[str, str]:
        if not directories:
            return {}
        paths = list(directories)
        keys = [f"{self._directory_generation_prefix}{path}" for path in paths]
        current = await self._client.mget(keys)
        generations = {
            path: _text(token)
            for path, token in zip(paths, current) if token is not None
        }
        missing = {path: uuid7() for path in paths if path not in generations}
        if missing:
            pipe = self._client.pipeline()
            for path, token in missing.items():
                pipe.set(f"{self._directory_generation_prefix}{path}",
                         token,
                         nx=True)
            await pipe.execute()
            generations.update(missing)
        # Keep observed or attempted tokens, including failed NX attempts:
        # rereading could adopt a token created after an invalidation.
        return generations

    async def _flush_seed(self) -> None:
        async with self._seed_lock:
            while self._pending_seeds:
                pending = list(self._pending_seeds)
                generation = await self._generation(self._generation_key)
                directories = {
                    path
                    for _, children, _ in pending
                    for path in children
                }
                directory_generations = await self._directory_generations(
                    directories)
                pipe = self._client.pipeline()
                for entries, children, expires_at in pending:
                    for vfs_path, entry in entries.items():
                        pipe.set(self._entry_key(vfs_path),
                                 entry.model_dump_json())
                    for vfs_path, child_keys in children.items():
                        listing = IndexDirectory(
                            entries=child_keys,
                            expires_at=expires_at.timestamp(),
                            generation=
                            f"{generation}:{directory_generations[vfs_path]}")
                        pipe.set(self._children_key(vfs_path),
                                 listing.model_dump_json())
                await pipe.execute()
                del self._pending_seeds[:len(pending)]

    async def get(self, vfs_path: str) -> LookupResult:
        await self._flush_seed()
        raw = await self._client.get(self._entry_key(vfs_path))
        if raw is None:
            return LookupResult(status=LookupStatus.NOT_FOUND)
        entry = IndexEntry.model_validate_json(raw)
        return LookupResult(entry=entry)

    async def put(self, vfs_path: str, entry: IndexEntry) -> None:
        await self._flush_seed()
        if not entry.index_time:
            entry = entry.model_copy(
                update={"index_time": to_iso_z(datetime.now(timezone.utc))})
        await self._client.set(self._entry_key(vfs_path),
                               entry.model_dump_json())

    async def list_dir(self, vfs_path: str) -> ListResult:
        await self._flush_seed()
        key = self._children_key(vfs_path)
        raw, current, directory = await self._client.mget(
            key, self._generation_key,
            f"{self._directory_generation_prefix}{vfs_path}")
        if raw is None:
            return ListResult(status=LookupStatus.NOT_FOUND)
        listing = IndexDirectory.model_validate_json(raw)
        if (current is None or directory is None
                or listing.generation != f"{_text(current)}:{_text(directory)}"
                or datetime.now(
                    timezone.utc).timestamp() >= listing.expires_at):
            return ListResult(status=LookupStatus.EXPIRED)
        return ListResult(entries=listing.entries)

    async def set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        await self._flush_seed()
        now = datetime.now(timezone.utc)
        now_iso = to_iso_z(now)
        prefix = "/" if vfs_path == "/" else vfs_path + "/"

        generation = await self._generation(self._generation_key)
        directory_generation = await self._generation(
            f"{self._directory_generation_prefix}{vfs_path}")
        pipe = self._client.pipeline()
        child_keys: list[str] = []
        for name, entry in entries:
            full_path = prefix + name
            if not entry.index_time:
                entry = entry.model_copy(update={"index_time": now_iso})
            pipe.set(self._entry_key(full_path), entry.model_dump_json())
            child_keys.append(full_path)

        expiry = expired_at if expired_at is not None else now + timedelta(
            seconds=self._ttl)
        listing = IndexDirectory(
            entries=child_keys,
            expires_at=expiry.timestamp(),
            generation=f"{generation}:{directory_generation}")
        pipe.set(self._children_key(vfs_path), listing.model_dump_json())

        await pipe.execute()

    async def entries(self) -> dict[str, IndexEntry]:
        await self._flush_seed()
        entries: dict[str, IndexEntry] = {}
        cursor = 0
        while True:
            cursor, keys = await self._client.scan(
                cursor,
                match=f"{_glob_escape(self._entry_prefix)}*",
                count=500)
            for key in keys:
                key_text = _text(key)
                raw = await self._client.get(key)
                if raw is not None:
                    vfs_path = key_text.removeprefix(self._entry_prefix)
                    entries[vfs_path] = IndexEntry.model_validate_json(raw)
            if cursor == 0:
                return entries

    async def invalidate_dir(self, vfs_path: str) -> None:
        await self._flush_seed()
        children_key = self._children_key(vfs_path)
        raw = await self._client.get(children_key)
        child_paths = IndexDirectory.model_validate_json(
            raw).entries if raw is not None else []
        pipe = self._client.pipeline()
        for child in child_paths:
            pipe.delete(self._entry_key(child))
        pipe.delete(children_key)
        pipe.delete(f"{self._directory_generation_prefix}{vfs_path}")
        await pipe.execute()

    async def _scan_delete(self, prefix: str, vfs_path: str) -> None:
        """Delete every key under ``prefix`` naming a path in the subtree.

        Args:
            prefix (str): Key namespace to scan (entries or children).
            vfs_path (str): Mount-absolute root of the subtree.
        """
        pattern = f"{_glob_escape(prefix + vfs_path.rstrip('/'))}*"
        cursor = 0
        while True:
            cursor, keys = await self._client.scan(cursor,
                                                   match=pattern,
                                                   count=500)
            doomed = [
                key for key in keys
                if under_path(_text(key).removeprefix(prefix), vfs_path)
            ]
            if doomed:
                await self._client.delete(*doomed)
            if cursor == 0:
                return

    async def invalidate_prefix(self, vfs_path: str) -> None:
        await self._flush_seed()
        await self._scan_delete(self._entry_prefix, vfs_path)
        await self._scan_delete(self._children_prefix, vfs_path)
        await self._scan_delete(self._directory_generation_prefix, vfs_path)

    async def invalidate(self) -> None:
        await self._flush_seed()
        # One atomic generation change expires all listings without racing
        # another client's refill or resurrecting a concurrently removed path.
        await self._client.set(self._generation_key, uuid7())

    async def clear(self) -> None:
        async with self._seed_lock:
            self._pending_seeds.clear()
            await self._scan_delete(self._entry_prefix, "/")
            await self._scan_delete(self._children_prefix, "/")
            await self._scan_delete(self._directory_generation_prefix, "/")
            await self._client.delete(self._generation_key)

    async def close(self) -> None:
        if self._closed:
            return
        await self._flush_seed()
        if self._owns_client:
            await self._client.aclose()
        await super().close()
