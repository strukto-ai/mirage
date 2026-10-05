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
import json
from collections.abc import Awaitable
from datetime import datetime, timedelta, timezone
from typing import cast

try:
    from redis.asyncio import Redis
    from redis.asyncio.client import Pipeline
    from redis.exceptions import ResponseError
except ImportError as _err:
    raise ImportError(
        "RedisIndexCacheStore requires the 'redis' extra. "
        "Install with: pip install mirage-ai[redis]"
    ) from _err

from mirage.cache.file.utils import glob_escape
from mirage.cache.index.config import (
    Evicted,
    IndexDirectory,
    IndexEntry,
    ListResult,
    LookupResult,
    LookupStatus,
)
from mirage.cache.index.constants import (
    CHILDREN_PREFIX,
    ENTRY_PREFIX,
    GENERATION_KEY,
    PATHS_KEY,
    TOMBSTONE_PREFIX,
)
from mirage.cache.index.store import IndexCacheStore
from mirage.utils.dates import to_iso_z
from mirage.utils.ids import uuid7


def _text(value: str | bytes) -> str:
    return value.decode() if isinstance(value, bytes) else value


_PendingSeed = tuple[
    dict[str, IndexEntry], dict[str, list[str]], datetime, str | None
]

_PATH_REGISTRY = """
local function track(registry, prefixes, paths)
  for _, path in ipairs(paths) do redis.call('ZADD', registry, 0, path) end
end
local function prune(registry, prefixes, path)
  for _, prefix in ipairs(prefixes) do
    if redis.call('EXISTS', prefix .. path) == 1 then return end
  end
  redis.call('ZREM', registry, path)
end
local function subtree(registry, root)
  root = string.gsub(root, '/+$', '')
  if root == '' then root = '/' end
  local lower = root == '/' and '/' or root .. '/'
  local upper = root == '/' and '0' or root .. '0'
  local paths = redis.call('ZRANGEBYLEX', registry, '[' .. lower, '(' .. upper)
  paths[#paths + 1] = root
  return paths
end
-- A row's kind: 'folder' or '<backend>/folder', 'file' or '<backend>/file'.
local function is_kind(row_type, kind)
  return type(row_type) == 'string' and (row_type == kind
    or string.sub(row_type, -(#kind + 1)) == '/' .. kind)
end
"""

_TRACK_PATHS = (
    _PATH_REGISTRY
    + """
local paths = {}
for i = 5, #ARGV do paths[#paths + 1] = ARGV[i] end
track(KEYS[1], {ARGV[1], ARGV[2], ARGV[3], ARGV[4]}, paths)
return 1
"""
)

_RECOVER_PATHS = """
local rebuilding = string.char(0)
if redis.call('ZSCORE', KEYS[1], '') then return {1, ''} end
if ARGV[2] == 'begin' then
  redis.call('ZADD', KEYS[1], 'NX', ARGV[1], rebuilding)
  return {0, redis.call('ZSCORE', KEYS[1], rebuilding)}
end
if redis.call('ZSCORE', KEYS[1], rebuilding) ~= ARGV[1] then
  return {-1, ''}
end
if ARGV[2] == 'finish' then
  redis.call('ZREM', KEYS[1], rebuilding)
  redis.call('ZADD', KEYS[1], 0, '')
  return {1, ''}
end
for i = 3, #ARGV, 2 do
  if redis.call('EXISTS', ARGV[i]) == 1 then
    redis.call('ZADD', KEYS[1], 0, ARGV[i + 1])
  end
end
return {0, ARGV[1]}
"""

_DELETE_PATHS = (
    _PATH_REGISTRY
    + """
if not redis.call('ZSCORE', KEYS[1], '') then
  error('MIRAGE_INDEX_REGISTRY_MISSING')
end
local prefixes = {ARGV[1], ARGV[2], ARGV[3], ARGV[4]}
local removed = cjson.decode(ARGV[5])
local excluded = cjson.decode(ARGV[7])
local root = string.gsub(ARGV[6], '/+$', '')
if root == '' then root = '/' end
local lower = root == '/' and '/' or root .. '/'
local upper = root == '/' and '0' or root .. '0'
local after = ARGV[8] == '' and '[' .. lower or '(' .. ARGV[8]
local paths = redis.call('ZRANGEBYLEX', KEYS[1], after, '(' .. upper,
  'LIMIT', 0, 128)
local cursor = #paths == 128 and paths[#paths] or ''
if ARGV[8] == '' then paths[#paths + 1] = root end
for _, path in ipairs(paths) do
  local protected = false
  for _, excluded_root in ipairs(excluded) do
    if path == excluded_root
      or string.sub(path, 1, #excluded_root + 1) == excluded_root .. '/' then
      protected = true
      break
    end
  end
  if not protected then
    for _, prefix in ipairs(removed) do redis.call('DEL', prefix .. path) end
    prune(KEYS[1], prefixes, path)
  end
end
return cursor
"""
)

_DELETE_ENTRY = (
    _PATH_REGISTRY
    + """
local prefixes = {ARGV[1], ARGV[2], ARGV[3], ARGV[4]}
track(KEYS[1], prefixes, {})
redis.call('DEL', ARGV[1] .. ARGV[5])
prune(KEYS[1], prefixes, ARGV[5])
"""
)

_SWAP_LISTING = (
    _PATH_REGISTRY
    + """
if not redis.call('ZSCORE', KEYS[3], '') then
  error('MIRAGE_INDEX_REGISTRY_MISSING')
end
track(KEYS[3], {ARGV[2], ARGV[3], ARGV[4], ARGV[5]},
  {string.sub(KEYS[1], #ARGV[3] + 1)})
local old = redis.call('GET', KEYS[1])
local tomb = redis.call('GET', KEYS[2])
redis.call('DEL', KEYS[2])
local excluded = cjson.decode(ARGV[6])
local function protected(path)
  for _, prefix in ipairs(excluded) do
    if path == prefix or string.sub(path, 1, #prefix + 1) == prefix .. '/' then
      return true
    end
  end
  return false
end
local named = {}
for i = 7, #ARGV, 2 do
  named[ARGV[i]] = cjson.decode(ARGV[i + 1]).resource_type
end
local seen, gone, folders = {}, {}, {}
local function drop(path, buried)
  if seen[path] or protected(path) then
    return
  end
  local row = redis.call('GET', ARGV[2] .. path)
  local folder = buried or redis.call('EXISTS', ARGV[3] .. path) == 1
    or (row ~= false and is_kind(cjson.decode(row).resource_type, 'folder'))
  if named[path] and not (folder and is_kind(named[path], 'file')) then
    return
  end
  seen[path] = true
  redis.call('DEL', ARGV[2] .. path)
  prune(KEYS[3], {ARGV[2], ARGV[3], ARGV[4], ARGV[5]}, path)
  gone[#gone + 1] = path
  folders[#folders + 1] = folder and 1 or 0
end
local buried = {}
local saved = tomb and cjson.decode(tomb) or false
if saved then
  for i, path in ipairs(saved.entries) do
    buried[path] = saved.folders[i] == 1
  end
end
if old then
  for _, path in ipairs(cjson.decode(old).entries) do
    drop(path, buried[path] == true)
  end
end
if saved then
  for _, path in ipairs(saved.entries) do drop(path, buried[path]) end
end
for i = 7, #ARGV, 2 do drop(ARGV[i], false) end
local roots = {}
for i, path in ipairs(gone) do
  if folders[i] == 1 then roots[#roots + 1] = path end
end
local function remove(path)
  if protected(path) then return end
  for _, prefix in ipairs({ARGV[2], ARGV[3], ARGV[4], ARGV[5]}) do
    redis.call('DEL', prefix .. path)
  end
  redis.call('ZREM', KEYS[3], path)
end
for _, root in ipairs(roots) do
  for _, path in ipairs(subtree(KEYS[3], root)) do remove(path) end
end
for i = 7, #ARGV, 2 do
  redis.call('SET', ARGV[2] .. ARGV[i], ARGV[i + 1])
  redis.call('ZADD', KEYS[3], 0, ARGV[i])
end
redis.call('SET', KEYS[1], ARGV[1])
return {gone, folders}
"""
)

_BURY_LISTING = (
    _PATH_REGISTRY
    + """
track(KEYS[4], {ARGV[1], ARGV[2], ARGV[3], ARGV[4]},
  {string.sub(KEYS[1], #ARGV[2] + 1)})
local raw = redis.call('GET', KEYS[1])
if raw then
  local listing = cjson.decode(raw)
  local entries, folders, positions = {}, {}, {}
  if listing.partial then
    local saved = redis.call('GET', KEYS[2])
    if saved then
      local tomb = cjson.decode(saved)
      for i, path in ipairs(tomb.entries) do
        entries[#entries + 1] = path
        folders[#folders + 1] = tomb.folders[i]
        positions[path] = #entries
      end
    end
  end
  for _, path in ipairs(listing.entries) do
    local row = redis.call('GET', ARGV[1] .. path)
    local folder = redis.call('EXISTS', ARGV[2] .. path) == 1
      or (row ~= false and is_kind(cjson.decode(row).resource_type, 'folder'))
    local position = positions[path]
    if not position then
      entries[#entries + 1] = path
      position = #entries
      positions[path] = position
    end
    folders[position] = (folder or folders[position] == 1) and 1 or 0
    redis.call('DEL', ARGV[1] .. path)
    prune(KEYS[4], {ARGV[1], ARGV[2], ARGV[3], ARGV[4]}, path)
  end
  redis.call('SET', KEYS[2],
    cjson.encode({entries = entries, folders = folders}))
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[3])
prune(KEYS[4], {ARGV[1], ARGV[2], ARGV[3], ARGV[4]},
  string.sub(KEYS[1], #ARGV[2] + 1))
"""
)


class RedisIndexCacheStore(IndexCacheStore):
    """Redis-backed index cache for remote VFS metadata.

    Stores IndexEntry objects as JSON strings and directory children as
    JSON records holding children and expiry, including empty listings.
    Like RAM, stale records remain until explicitly cleared or invalidated by
    path, so expiry is distinguishable from absence. Redis eviction may still
    remove records; size limits belong to the server, not this store.
    Complete-list replacement and its subtree eviction are atomic. A path
    registry limits eviction to the removed subtrees. A missing registry is
    rebuilt in client-side scan batches; prefix invalidation also yields
    between batches.

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
        self._client = (
            client
            if client is not None
            else Redis.from_url(url, decode_responses=True)
        )
        self._owns_client = client is None
        self._pending_seeds: list[_PendingSeed] = []
        self._seed_lock = asyncio.Lock()
        self._generation_tasks: dict[str, asyncio.Task[str]] = {}
        p = key_prefix or ""
        self._key_prefix = p
        self._entry_prefix = f"{p}{ENTRY_PREFIX}"
        self._children_prefix = f"{p}{CHILDREN_PREFIX}"
        self._tombstone_prefix = f"{p}{TOMBSTONE_PREFIX}"
        self._generation_key = f"{p}{GENERATION_KEY}"
        self._paths_key = f"{p}{PATHS_KEY}"
        self._directory_generation_prefix = f"{self._generation_key}:"

    def _entry_key(self, vfs_path: str) -> str:
        return f"{self._entry_prefix}{vfs_path}"

    def _children_key(self, vfs_path: str) -> str:
        return f"{self._children_prefix}{vfs_path}"

    def _track_paths(self, pipe: Pipeline, paths: list[str]) -> None:
        pipe.eval(
            _TRACK_PATHS,
            1,
            self._paths_key,
            self._entry_prefix,
            self._children_prefix,
            self._tombstone_prefix,
            self._directory_generation_prefix,
            *paths,
        )

    async def _recover_paths(self) -> None:
        prefixes = (
            self._entry_prefix,
            self._children_prefix,
            self._tombstone_prefix,
            self._directory_generation_prefix,
        )
        for _ in range(3):
            candidate = str(int(uuid7().replace("-", "")[-12:], 16))
            status, raw_token = await cast(
                Awaitable[tuple[int, str | bytes]],
                self._client.eval(
                    _RECOVER_PATHS, 1, self._paths_key, candidate, "begin"
                ),
            )
            if status == 1:
                return
            token = _text(raw_token)
            cursor = 0
            while True:
                cursor, keys = await self._client.scan(
                    cursor,
                    match=f"{glob_escape(self._key_prefix)}mirage:idx:*",
                    count=128,
                )
                rows: list[str] = []
                for raw in keys:
                    key = _text(raw)
                    for prefix in prefixes:
                        if key.startswith(prefix):
                            rows.extend((key, key[len(prefix) :]))
                            break
                for start in range(0, len(rows), 256):
                    status, _ = await cast(
                        Awaitable[tuple[int, str | bytes]],
                        self._client.eval(
                            _RECOVER_PATHS,
                            1,
                            self._paths_key,
                            token,
                            "batch",
                            *rows[start : start + 256],
                        ),
                    )
                    if status != 0:
                        break
                if status != 0 or cursor == 0:
                    break
            if status == 1:
                return
            if status == -1:
                continue
            status, _ = await cast(
                Awaitable[tuple[int, str | bytes]],
                self._client.eval(
                    _RECOVER_PATHS, 1, self._paths_key, token, "finish"
                ),
            )
            if status == 1:
                return
        raise RuntimeError(
            "Redis repeatedly evicted the index path registry during recovery"
        )

    async def _eval_complete(
        self, script: str, keys: list[str], args: list[str]
    ) -> str | bytes | tuple[list[str | bytes], list[int]]:
        for attempt in range(3):
            try:
                return await cast(
                    Awaitable[
                        str | bytes | tuple[list[str | bytes], list[int]]
                    ],
                    self._client.eval(script, len(keys), *keys, *args),
                )
            except ResponseError as error:
                if (
                    "MIRAGE_INDEX_REGISTRY_MISSING" not in str(error)
                    or attempt == 2
                ):
                    raise
                await self._recover_paths()
        raise RuntimeError("Redis index path registry recovery failed")

    def seed(
        self,
        entries: dict[str, IndexEntry],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        now_iso = to_iso_z(datetime.now(timezone.utc))
        self._pending_seeds.append(
            (
                {
                    path: entry
                    if entry.index_time
                    else entry.model_copy(update={"index_time": now_iso})
                    for path, entry in entries.items()
                },
                {path: list(keys) for path, keys in children.items()},
                expires_at,
                version,
            )
        )

    async def _generation(self, key: str) -> str:
        task = self._generation_tasks.get(key)
        if task is None or task.done():

            async def initialize() -> str:
                current = await self._client.get(key)
                if current is not None:
                    return _text(current)
                generation = uuid7()
                if key == self._generation_key:
                    await self._client.set(key, generation, nx=True)
                else:
                    pipe = self._client.pipeline()
                    self._track_paths(
                        pipe,
                        [key.removeprefix(self._directory_generation_prefix)],
                    )
                    pipe.set(key, generation, nx=True)
                    await pipe.execute()
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

    async def _directory_generations(
        self, directories: set[str]
    ) -> dict[str, str]:
        if not directories:
            return {}
        paths = list(directories)
        keys = [f"{self._directory_generation_prefix}{path}" for path in paths]
        current = await self._client.mget(keys)
        generations = {
            path: _text(token)
            for path, token in zip(paths, current)
            if token is not None
        }
        missing = {path: uuid7() for path in paths if path not in generations}
        if missing:
            pipe = self._client.pipeline()
            self._track_paths(pipe, list(missing))
            for path, token in missing.items():
                pipe.set(
                    f"{self._directory_generation_prefix}{path}",
                    token,
                    nx=True,
                )
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
                    path for _, children, _, _ in pending for path in children
                }
                directory_generations = await self._directory_generations(
                    directories
                )
                pipe = self._client.pipeline()
                self._track_paths(
                    pipe,
                    [
                        path
                        for entries, children, _, _ in pending
                        for path in set(entries) | set(children)
                    ],
                )
                for entries, children, expires_at, version in pending:
                    for vfs_path, entry in entries.items():
                        pipe.set(
                            self._entry_key(vfs_path), entry.model_dump_json()
                        )
                    for vfs_path, child_keys in children.items():
                        listing = IndexDirectory(
                            entries=child_keys,
                            expires_at=expires_at.timestamp(),
                            generation=f"{generation}:{directory_generations[vfs_path]}",
                            version=version,
                        )
                        pipe.set(
                            self._children_key(vfs_path),
                            listing.model_dump_json(),
                        )
                await pipe.execute()
                del self._pending_seeds[: len(pending)]

    @property
    def ttl(self) -> float:
        return self._ttl

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
                update={"index_time": to_iso_z(datetime.now(timezone.utc))}
            )
        pipe = self._client.pipeline()
        self._track_paths(pipe, [vfs_path])
        pipe.set(self._entry_key(vfs_path), entry.model_dump_json())
        await pipe.execute()

    async def list_dir(self, vfs_path: str) -> ListResult:
        await self._flush_seed()
        key = self._children_key(vfs_path)
        raw, current, directory = await self._client.mget(
            key,
            self._generation_key,
            f"{self._directory_generation_prefix}{vfs_path}",
        )
        if raw is None:
            return ListResult(status=LookupStatus.NOT_FOUND)
        listing = IndexDirectory.model_validate_json(raw)
        if (
            current is None
            or directory is None
            or listing.generation != f"{_text(current)}:{_text(directory)}"
            or datetime.now(timezone.utc).timestamp() >= listing.expires_at
        ):
            return ListResult(status=LookupStatus.EXPIRED)
        if listing.partial:
            return ListResult(
                partial_entries=listing.entries, version=listing.version
            )
        return ListResult(entries=listing.entries, version=listing.version)

    async def set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
        *,
        window: bool = False,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        return await self._set_dir(
            vfs_path,
            entries,
            expired_at,
            partial=False,
            evict=not window,
            excluded=excluded,
            version=version,
        )

    async def set_partial_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None = None,
    ) -> None:
        await self._set_dir(
            vfs_path, entries, expired_at, partial=True, evict=False
        )

    async def _set_dir(
        self,
        vfs_path: str,
        entries: list[tuple[str, IndexEntry]],
        expired_at: datetime | None,
        *,
        partial: bool,
        evict: bool,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        await self._flush_seed()
        now = datetime.now(timezone.utc)
        now_iso = to_iso_z(now)
        prefix = "/" if vfs_path == "/" else vfs_path + "/"

        generation = await self._generation(self._generation_key)
        directory_generation = await self._generation(
            f"{self._directory_generation_prefix}{vfs_path}"
        )
        rows: list[tuple[str, str]] = []
        for name, entry in entries:
            if not entry.index_time:
                entry = entry.model_copy(update={"index_time": now_iso})
            rows.append((prefix + name, entry.model_dump_json()))

        expiry = (
            expired_at
            if expired_at is not None
            else now + timedelta(seconds=self._ttl)
        )
        listing = IndexDirectory(
            entries=[path for path, _ in rows],
            expires_at=expiry.timestamp(),
            generation=f"{generation}:{directory_generation}",
            partial=partial,
            version=None if partial else version,
        )
        if not evict:
            pipe = self._client.pipeline()
            self._track_paths(pipe, [vfs_path, *(path for path, _ in rows)])
            for path, row in rows:
                pipe.set(self._entry_key(path), row)
            pipe.set(self._children_key(vfs_path), listing.model_dump_json())
            if not partial:
                # A window is the new full knowledge; it proves nothing gone
                # and leaves nothing for a later listing to diff against.
                pipe.delete(self._tombstone_prefix + vfs_path)
            await pipe.execute()
            return []
        # One script, so no other writer lands between reading the previous
        # listing and replacing it; the diff is against the true predecessor.
        gone, folders = cast(
            tuple[list[str | bytes], list[int]],
            await self._eval_complete(
                _SWAP_LISTING,
                [
                    self._children_key(vfs_path),
                    self._tombstone_prefix + vfs_path,
                    self._paths_key,
                ],
                [
                    listing.model_dump_json(),
                    self._entry_prefix,
                    self._children_prefix,
                    self._tombstone_prefix,
                    self._directory_generation_prefix,
                    json.dumps([p.rstrip("/") for p in excluded]),
                    *(value for row in rows for value in row),
                ],
            ),
        )
        dropped: list[Evicted] = []
        for raw, flag in zip(gone, folders):
            key = _text(raw)
            dropped.append(Evicted(key, folder=bool(flag)))
        return dropped

    async def entries(self) -> dict[str, IndexEntry]:
        await self._flush_seed()
        entries: dict[str, IndexEntry] = {}
        cursor = 0
        while True:
            cursor, keys = await self._client.scan(
                cursor, match=f"{glob_escape(self._entry_prefix)}*", count=500
            )
            for key in keys:
                key_text = _text(key)
                raw = await self._client.get(key)
                if raw is not None:
                    vfs_path = key_text.removeprefix(self._entry_prefix)
                    entries[vfs_path] = IndexEntry.model_validate_json(raw)
            if cursor == 0:
                return entries

    async def invalidate_entry(self, vfs_path: str) -> None:
        await self._flush_seed()
        await cast(
            Awaitable[None],
            self._client.eval(
                _DELETE_ENTRY,
                1,
                self._paths_key,
                self._entry_prefix,
                self._children_prefix,
                self._tombstone_prefix,
                self._directory_generation_prefix,
                vfs_path,
            ),
        )

    async def invalidate_dir(self, vfs_path: str) -> None:
        await self._flush_seed()
        # The child list becomes a tombstone, so the next complete listing
        # can still tell which children went away.
        await cast(
            Awaitable[None],
            self._client.eval(
                _BURY_LISTING,
                4,
                self._children_key(vfs_path),
                self._tombstone_prefix + vfs_path,
                f"{self._directory_generation_prefix}{vfs_path}",
                self._paths_key,
                self._entry_prefix,
                self._children_prefix,
                self._tombstone_prefix,
                self._directory_generation_prefix,
            ),
        )

    async def _delete_paths(
        self,
        prefixes: list[str],
        vfs_path: str,
        excluded: tuple[str, ...] = (),
    ) -> None:
        cursor = ""
        while True:
            raw = await self._eval_complete(
                _DELETE_PATHS,
                [self._paths_key],
                [
                    self._entry_prefix,
                    self._children_prefix,
                    self._tombstone_prefix,
                    self._directory_generation_prefix,
                    json.dumps(prefixes),
                    vfs_path,
                    json.dumps([p.rstrip("/") for p in excluded]),
                    cursor,
                ],
            )
            cursor = _text(cast(str | bytes, raw))
            if not cursor:
                return

    async def invalidate_prefix(
        self, vfs_path: str, *, excluded: tuple[str, ...] = ()
    ) -> None:
        await self._flush_seed()
        # Tombstones survive until the next complete listing proves removals.
        await self._delete_paths([self._entry_prefix], vfs_path, excluded)
        await self._delete_paths(
            [self._children_prefix, self._directory_generation_prefix],
            vfs_path,
            excluded,
        )

    async def invalidate(self) -> None:
        await self._flush_seed()
        # One atomic generation change expires all listings without racing
        # another client's refill or resurrecting a concurrently removed path.
        await self._client.set(self._generation_key, uuid7())

    async def clear(self) -> None:
        async with self._seed_lock:
            self._pending_seeds.clear()
            await self._delete_paths([self._entry_prefix], "/")
            await self._delete_paths(
                [
                    self._children_prefix,
                    self._tombstone_prefix,
                    self._directory_generation_prefix,
                ],
                "/",
            )
            await self._client.delete(self._generation_key)

    async def close(self) -> None:
        if self._closed:
            return
        await self._flush_seed()
        if self._owns_client:
            await self._client.aclose()
        await super().close()
