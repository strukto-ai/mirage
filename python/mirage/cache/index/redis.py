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
import functools
import json
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any, Concatenate, ParamSpec, TypeVar, cast

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
    ListResult,
    LookupResult,
    LookupStatus,
)
from mirage.cache.index.constants import (
    CHILDREN_PREFIX,
    DEFAULT_KEY_PREFIX,
    ENTRY_PREFIX,
    GENERATION_KEY,
    PATHS_KEY,
    REGISTRY_PAGE,
    TOMBSTONE_PREFIX,
)
from mirage.cache.index.listing_memo import ListingMemo
from mirage.cache.index.store import IndexCacheStore
from mirage.types import FileStat, FileType
from mirage.utils.clock import Clock
from mirage.utils.ids import uuid7


def _text(value: str | bytes) -> str:
    return value.decode() if isinstance(value, bytes) else value


def _row(raw: str | bytes) -> FileStat:
    """An index row read back from its JSON.

    Args:
        raw (str | bytes): the stored JSON.
    """
    return FileStat.model_validate(json.loads(raw))


_PendingSeed = tuple[
    dict[str, FileStat], dict[str, list[str]], datetime, str | None
]

P = ParamSpec("P")
R = TypeVar("R")


def _counts_listing_write(
    method: Callable[
        Concatenate["RedisIndexCacheStore", P], Coroutine[Any, Any, R]
    ],
) -> Callable[Concatenate["RedisIndexCacheStore", P], Coroutine[Any, Any, R]]:
    @functools.wraps(method)
    async def counted(
        self: "RedisIndexCacheStore", *args: P.args, **kwargs: P.kwargs
    ) -> R:
        try:
            return await method(self, *args, **kwargs)
        finally:
            self._listings.wrote()

    return counted


_REPLACE_ENTRY = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
"""

_PATH_RANGE = """
local function path_range(root)
  root = string.gsub(root, '/+$', '')
  if root == '' then root = '/' end
  local lower = root == '/' and '/' or root .. '/'
  local upper = root == '/' and '0' or root .. '0'
  return root, lower, upper
end
"""

_PATH_REGISTRY = (
    _PATH_RANGE
    + """
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
  local root, lower, upper = path_range(root)
  local paths = redis.call('ZRANGEBYLEX', registry, '[' .. lower, '(' .. upper)
  paths[#paths + 1] = root
  return paths
end
-- Whether a stored row, a FileStat's JSON, is a directory's.
local function is_dir(row)
  return row.type == 'directory'
end
"""
)

_LISTING_HISTORY = (
    _PATH_REGISTRY
    + """
local function bury(key, listing)
  local raw = redis.call('GET', key)
  local saved = raw and cjson.decode(raw) or {entries = {}, folders = {}}
  local positions = {}
  for i, path in ipairs(saved.entries) do positions[path] = i end
  for i, path in ipairs(listing.entries) do
    local position = positions[path]
    if not position then
      saved.entries[#saved.entries + 1] = path
      position = #saved.entries
      positions[path] = position
    end
    saved.folders[position] =
      (saved.folders[position] == 1 or listing.folders[i] == 1) and 1 or 0
  end
  if #saved.entries > 0 then redis.call('SET', key, cjson.encode(saved)) end
end
local function encode_listing(listing, predecessor)
  local encoded = string.gsub(string.gsub(cjson.encode(listing),
    '"entries":{}', '"entries":[]'), '"folders":{}', '"folders":[]')
  local deadline = string.match(predecessor, '"expires_at"%s*:%s*([%d%.eE%+%-]+)')
  return (string.gsub(encoded, '"expires_at":[%d%.eE%+%-]+',
    '"expires_at":' .. deadline))
end
local function publish_listing(
  key, listing, raw, global_key, directory_key, replacement)
  if replacement ~= '' then
    local current = redis.call('GET', global_key)
    local directory = redis.call('GET', directory_key)
    if current and directory and listing.generation == current .. ':' .. directory then
      listing.generation = current .. ':' .. replacement
    end
    redis.call('SET', directory_key, replacement)
  end
  redis.call('SET', key, encode_listing(listing, raw))
end
local function remember_directory(children_prefix, tombstone_prefix, path)
  path = string.gsub(path, '/+$', '')
  if path == '' then return end
  local parent = string.match(path, '^(.*)/[^/]+$')
  if parent == '' then parent = '/' end
  for i, prefix in ipairs({children_prefix, tombstone_prefix}) do
    local key = prefix .. parent
    local raw = redis.call('GET', key)
    if raw then
      local listing = cjson.decode(raw)
      for position, child in ipairs(listing.entries) do
        if child == path and listing.folders[position] ~= 1 then
          listing.folders[position] = 1
          redis.call('SET', key, i == 1 and encode_listing(listing, raw)
            or cjson.encode(listing))
          break
        end
      end
    end
  end
end
"""
)

_SEED_LISTING = (
    _LISTING_HISTORY
    + """
local listing = cjson.decode(ARGV[1])
for offset = 1, #listing.entries, 128 do
  local keys = {}
  local last = math.min(offset + 127, #listing.entries)
  for i = offset, last do
    keys[#keys + 1] = ARGV[5] .. listing.entries[i]
    keys[#keys + 1] = ARGV[2] .. listing.entries[i]
  end
  local saved = redis.call('MGET', unpack(keys))
  for i = offset, last do
    local position = (i - offset) * 2 + 1
    local row = saved[position]
    listing.folders[i] = (listing.folders[i] == 1 or saved[position + 1] ~= false
      or (row ~= false and is_dir(cjson.decode(row)))) and 1 or 0
  end
end
publish_listing(KEYS[1], listing, ARGV[1], KEYS[2], KEYS[3], ARGV[6])
remember_directory(ARGV[2], ARGV[3], ARGV[4])
return 1
"""
)

_PUT_ENTRY = (
    _LISTING_HISTORY
    + """
local old = redis.call('GET', KEYS[1])
if old and cjson.decode(old).type == 'directory'
    and cjson.decode(ARGV[2]).type ~= 'directory' then
  bury(KEYS[2], {entries = {ARGV[1]}, folders = {1}})
  redis.call('ZADD', KEYS[3], 0, ARGV[3])
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
"""
)

_ADD_ENTRY = (
    _LISTING_HISTORY
    + """
local raw = redis.call('GET', KEYS[1])
local current = redis.call('GET', KEYS[2])
local directory = redis.call('GET', KEYS[3])
local fresh = cjson.decode(ARGV[4])
if not current or not directory or fresh.generation ~= current .. ':' .. directory then
  redis.call('SET', KEYS[5], ARGV[6])
  if raw and current and directory then
    local listing = cjson.decode(raw)
    if listing.generation == current .. ':' .. directory
        and tonumber(ARGV[5]) < listing.expires_at then
      for i, path in ipairs(listing.entries) do
        if path == ARGV[3] then
          bury(KEYS[4], {entries = {path}, folders = {listing.folders[i]}})
          table.remove(listing.entries, i)
          table.remove(listing.folders, i)
          break
        end
      end
      listing.partial = true
      listing.version = cjson.null
      listing.window = false
      listing.generation = current .. ':' .. ARGV[6]
      redis.call('SET', KEYS[3], ARGV[6])
      redis.call('SET', KEYS[1], encode_listing(listing, raw))
    end
  end
  return 0
end
local old = redis.call('GET', ARGV[1])
redis.call('SET', KEYS[3], ARGV[6])
local folder = cjson.decode(ARGV[2]).type == 'directory' and 1 or 0
if old and cjson.decode(old).type == 'directory' and folder == 0 then
  bury(KEYS[4], {entries = {ARGV[3]}, folders = {1}})
end
redis.call('SET', ARGV[1], ARGV[2])
if raw then
  local listing = cjson.decode(raw)
  if current and directory and listing.generation == current .. ':' .. directory
      and tonumber(ARGV[5]) < listing.expires_at then
    listing.generation = current .. ':' .. ARGV[6]
    if old and cjson.decode(old).type == 'directory' and folder == 0 then
      listing.partial = true
      listing.version = cjson.null
      listing.window = false
    end
    local position = #listing.entries + 1
    for i, path in ipairs(listing.entries) do
      if path == ARGV[3] then
        if listing.folders[i] == 1 and folder == 0 then
          bury(KEYS[4], {entries = {ARGV[3]}, folders = {1}})
          listing.partial = true
          listing.version = cjson.null
          listing.window = false
        end
        listing.folders[i] = folder
        redis.call('SET', KEYS[1], encode_listing(listing, raw))
        return 0
      end
      if path > ARGV[3] then position = i break end
    end
    table.insert(listing.entries, position, ARGV[3])
    table.insert(listing.folders, position, folder)
    redis.call('SET', KEYS[1], encode_listing(listing, raw))
    return 1
  end
  bury(KEYS[4], listing)
end
fresh.generation = current .. ':' .. ARGV[6]
redis.call('SET', KEYS[1], encode_listing(fresh, ARGV[4]))
return 1
"""
)

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
local root, lower, upper = path_range(ARGV[6])
local page = tonumber(ARGV[9])
local after = ARGV[8] == '' and '[' .. lower or '(' .. ARGV[8]
local paths = redis.call('ZRANGEBYLEX', KEYS[1], after, '(' .. upper,
  'LIMIT', 0, page)
local cursor = #paths == page and paths[#paths] or ''
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

_HOLDS_SUBTREE = (
    _PATH_RANGE
    + """
if not redis.call('ZSCORE', KEYS[1], '') then
  error('MIRAGE_INDEX_REGISTRY_MISSING')
end
local key, lower, upper = path_range(ARGV[2])
local cursor, page = ARGV[3], tonumber(ARGV[4])
if cursor == '' and redis.call('EXISTS', ARGV[1] .. key) == 1 then
  return {1, ''}
end
local after = cursor == '' and '[' .. lower or '(' .. cursor
local paths = redis.call('ZRANGEBYLEX', KEYS[1], after, '(' .. upper,
  'LIMIT', 0, page)
for _, path in ipairs(paths) do
  if redis.call('EXISTS', ARGV[1] .. path) == 1 then return {1, ''} end
end
return {0, #paths == page and paths[#paths] or ''}
"""
)

_DELETE_ENTRY = (
    _LISTING_HISTORY
    + """
local prefixes = {ARGV[1], ARGV[2], ARGV[3], ARGV[4]}
track(KEYS[1], prefixes, {string.sub(KEYS[2], #ARGV[2] + 1)})
local raw = redis.call('GET', KEYS[2])
local current = redis.call('GET', KEYS[4])
local directory = redis.call('GET', KEYS[5])
local old = redis.call('GET', KEYS[6])
if (old and is_dir(cjson.decode(old)))
  or redis.call('EXISTS', ARGV[2] .. ARGV[5]) == 1 then
  bury(KEYS[3], {entries = {ARGV[5]}, folders = {1}})
end
if raw then
  local listing = cjson.decode(raw)
  bury(KEYS[3], listing)
  for i, path in ipairs(listing.entries) do
    if path == ARGV[5] then
      table.remove(listing.entries, i)
      table.remove(listing.folders, i)
      break
    end
  end
  if current and directory and listing.generation == current .. ':' .. directory then
    listing.generation = current .. ':' .. ARGV[6]
  end
  listing.partial = true
  listing.version = cjson.null
  listing.window = false
  redis.call('SET', KEYS[2], encode_listing(listing, raw))
end
redis.call('SET', KEYS[5], ARGV[6])
redis.call('DEL', KEYS[6])
prune(KEYS[1], prefixes, ARGV[5])
"""
)

_WRITE_LISTING = (
    _LISTING_HISTORY
    + """
local next = cjson.decode(ARGV[1])
local path = string.sub(KEYS[1], #ARGV[3] + 1)
track(KEYS[3], {ARGV[2], ARGV[3], ARGV[4], ARGV[5]}, {path})
if next.partial then
  local old = redis.call('GET', KEYS[1])
  if old then bury(KEYS[2], cjson.decode(old)) end
else
  redis.call('DEL', KEYS[2])
end
for i = 8, #ARGV, 2 do
  if next.partial then
    local old = redis.call('GET', ARGV[2] .. ARGV[i])
    if (old and is_dir(cjson.decode(old)))
      or redis.call('EXISTS', ARGV[3] .. ARGV[i]) == 1 then
      bury(KEYS[2], {entries = {ARGV[i]}, folders = {1}})
    end
  end
  redis.call('SET', ARGV[2] .. ARGV[i], ARGV[i + 1])
  redis.call('ZADD', KEYS[3], 0, ARGV[i])
end
publish_listing(KEYS[1], next, ARGV[1], KEYS[4], KEYS[5], ARGV[7])
remember_directory(ARGV[3], ARGV[4], path)
return 1
"""
)

_SWAP_LISTING = (
    _LISTING_HISTORY
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
for i = 8, #ARGV, 2 do
  named[ARGV[i]] = is_dir(cjson.decode(ARGV[i + 1]))
end
local seen, gone, folders = {}, {}, {}
local function drop(path, buried)
  if seen[path] or protected(path) then
    return
  end
  local row = redis.call('GET', ARGV[2] .. path)
  local folder = buried or redis.call('EXISTS', ARGV[3] .. path) == 1
    or (row ~= false and is_dir(cjson.decode(row)))
  if named[path] ~= nil and not (folder and not named[path]) then
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
  local listing = cjson.decode(old)
  for i, path in ipairs(listing.entries) do
    drop(path, buried[path] == true or listing.folders[i] == 1)
  end
end
if saved then
  for _, path in ipairs(saved.entries) do drop(path, buried[path]) end
end
for i = 8, #ARGV, 2 do drop(ARGV[i], false) end
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
for i = 8, #ARGV, 2 do
  redis.call('SET', ARGV[2] .. ARGV[i], ARGV[i + 1])
  redis.call('ZADD', KEYS[3], 0, ARGV[i])
end
publish_listing(KEYS[1], cjson.decode(ARGV[1]), ARGV[1], KEYS[4], KEYS[5], ARGV[7])
remember_directory(ARGV[3], ARGV[4], string.sub(KEYS[1], #ARGV[3] + 1))
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
  local saved = redis.call('GET', KEYS[2])
  if saved then
      local tomb = cjson.decode(saved)
      for i, path in ipairs(tomb.entries) do
        entries[#entries + 1] = path
        folders[#folders + 1] = tomb.folders[i]
        positions[path] = #entries
      end
  end
  for i, path in ipairs(listing.entries) do
    local row = redis.call('GET', ARGV[1] .. path)
    local folder = listing.folders[i] == 1
      or redis.call('EXISTS', ARGV[2] .. path) == 1
      or (row ~= false and is_dir(cjson.decode(row)))
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

    Stores index rows as JSON strings and directory children as
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

        {key_prefix}mirage:idx:entry:{vfs_path} -> row JSON
        {key_prefix}mirage:idx:directory:{vfs_path} -> IndexDirectory JSON

    Args:
        ttl (float): Default time-to-live in seconds for directory listings.
        url (str): Redis connection URL, used when *client* is not provided.
        client (Redis | None): Pre-existing async Redis client. When given,
            the store will not close it on ``close()``.
        key_prefix (str): Namespace prefix prepended to every Redis key,
            allowing multiple stores to coexist on the same server.
        clock (Clock | None): the clock listing expiries are stamped and
            compared on; None means the system clock.
    """

    def __init__(
        self,
        ttl: float = 600,
        url: str = "redis://localhost:6379/0",
        client: Redis | None = None,
        key_prefix: str = DEFAULT_KEY_PREFIX,
        clock: Clock | None = None,
    ) -> None:
        super().__init__(clock)
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
        self._listings = ListingMemo(p, self.clock)

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
    ) -> (
        str
        | bytes
        | int
        | tuple[list[str | bytes], list[int]]
        | tuple[int, str | bytes]
    ):
        for attempt in range(3):
            try:
                return await cast(
                    Awaitable[
                        str
                        | bytes
                        | int
                        | tuple[list[str | bytes], list[int]]
                        | tuple[int, str | bytes]
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
        entries: dict[str, FileStat],
        children: dict[str, list[str]],
        expires_at: datetime,
        *,
        version: str | None = None,
    ) -> None:
        self._pending_seeds.append(
            (
                dict(entries),
                {path: list(keys) for path, keys in children.items()},
                expires_at,
                version,
            )
        )
        self._listings.wrote()

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
                last_seed = {
                    path: number
                    for number, (_, children, _, _) in enumerate(pending)
                    for path in children
                }
                directory_generations = await self._directory_generations(
                    set(last_seed)
                )
                rows = {
                    path: entry
                    for entries, _, _, _ in pending
                    for path, entry in entries.items()
                }
                pipe = self._client.pipeline()
                self._track_paths(
                    pipe,
                    [
                        path
                        for entries, children, _, _ in pending
                        for path in set(entries) | set(children)
                    ],
                )
                for number, (
                    entries,
                    children,
                    expires_at,
                    version,
                ) in enumerate(pending):
                    for vfs_path, entry in entries.items():
                        pipe.set(
                            self._entry_key(vfs_path), entry.model_dump_json()
                        )
                    for vfs_path, child_keys in children.items():
                        listing = IndexDirectory(
                            entries=child_keys,
                            folders=[
                                int(
                                    key in last_seed
                                    or (
                                        key in rows
                                        and rows[key].type
                                        is FileType.DIRECTORY
                                    )
                                )
                                for key in child_keys
                            ],
                            expires_at=expires_at.timestamp(),
                            generation=f"{generation}:{directory_generations[vfs_path]}",
                            version=version,
                        )
                        pipe.eval(
                            _SEED_LISTING,
                            3,
                            self._children_key(vfs_path),
                            self._generation_key,
                            f"{self._directory_generation_prefix}{vfs_path}",
                            listing.model_dump_json(),
                            self._children_prefix,
                            self._tombstone_prefix,
                            vfs_path,
                            self._entry_prefix,
                            uuid7() if last_seed[vfs_path] == number else "",
                        )
                try:
                    await pipe.execute()
                finally:
                    self._listings.wrote()
                del self._pending_seeds[: len(pending)]

    @property
    def ttl(self) -> float:
        return self._ttl

    async def get(self, vfs_path: str) -> LookupResult:
        await self._flush_seed()
        cached = await self._listings.row(vfs_path, self.get_many)
        if cached is not None:
            return LookupResult(entry=cached)
        raw = await self._client.get(self._entry_key(vfs_path))
        if raw is None:
            return LookupResult(status=LookupStatus.NOT_FOUND)
        return LookupResult(entry=_row(raw))

    async def get_many(self, vfs_paths: Sequence[str]) -> dict[str, FileStat]:
        paths = list(dict.fromkeys(vfs_paths))
        if not paths:
            return {}
        await self._flush_seed()
        rows = await self._client.mget(
            [self._entry_key(path) for path in paths]
        )
        return {
            path: _row(raw)
            for path, raw in zip(paths, rows, strict=True)
            if raw is not None
        }

    async def put(self, vfs_path: str, entry: FileStat) -> None:
        await self._flush_seed()
        pipe = self._client.pipeline()
        self._track_paths(pipe, [vfs_path])
        folder = vfs_path.rsplit("/", 1)[0] or "/"
        pipe.eval(
            _PUT_ENTRY,
            3,
            self._entry_key(vfs_path),
            self._tombstone_prefix + folder,
            self._paths_key,
            vfs_path,
            entry.model_dump_json(),
            folder,
        )
        try:
            await pipe.execute()
        finally:
            self._listings.row_wrote(vfs_path)

    @_counts_listing_write
    async def add_entry(
        self,
        vfs_path: str,
        entry: FileStat,
        expired_at: datetime | None = None,
    ) -> None:
        await self._flush_seed()
        folder = vfs_path.rsplit("/", 1)[0] or "/"
        now = datetime.fromtimestamp(self.clock.now(), timezone.utc)
        lifetime = now + timedelta(seconds=self._ttl)
        generation = await self._generation(self._generation_key)
        directory_generation = await self._generation(
            f"{self._directory_generation_prefix}{folder}"
        )
        fresh = IndexDirectory(
            entries=[vfs_path],
            folders=[int(entry.type is FileType.DIRECTORY)],
            expires_at=(
                lifetime if expired_at is None else min(lifetime, expired_at)
            ).timestamp(),
            generation=f"{generation}:{directory_generation}",
            partial=True,
        )
        pipe = self._client.pipeline()
        self._track_paths(pipe, [folder, vfs_path])
        pipe.eval(
            _ADD_ENTRY,
            5,
            self._children_key(folder),
            self._generation_key,
            f"{self._directory_generation_prefix}{folder}",
            self._tombstone_prefix + folder,
            f"{self._directory_generation_prefix}{vfs_path}",
            self._entry_key(vfs_path),
            entry.model_dump_json(),
            vfs_path,
            fresh.model_dump_json(),
            str(now.timestamp()),
            uuid7(),
        )
        await pipe.execute()

    async def replace_if_unchanged(
        self, vfs_path: str, predecessor: str, entry: FileStat
    ) -> bool:
        await self._flush_seed()
        key = self._entry_key(vfs_path)
        raw = await self._client.get(key)
        if raw is None or _row(raw).model_dump() != json.loads(predecessor):
            return False
        try:
            result = await cast(
                Awaitable[int],
                self._client.eval(
                    _REPLACE_ENTRY, 1, key, raw, entry.model_dump_json()
                ),
            )
            return result == 1
        finally:
            self._listings.row_wrote(vfs_path)

    async def list_dir(self, vfs_path: str) -> ListResult:
        """A folder's listing, read from Redis at most once per command.

        Inside a shell command, a later call for the same folder is
        answered from this process's memory while no listing write to
        this key prefix has finished in this process since the read
        began, the read is under LISTING_TRUST_WINDOW seconds old, and
        the listing has not reached its own expiry. A write by another
        process is therefore seen within that window, and by every new
        command at its first read. Outside a command every call reads
        Redis.

        Args:
            vfs_path (str): the listed folder's key.
        """
        return await self._listings.read(
            vfs_path, lambda: self._read_listing(vfs_path)
        )

    async def _read_listing(
        self, vfs_path: str
    ) -> tuple[ListResult, float | None]:
        await self._flush_seed()
        key = self._children_key(vfs_path)
        raw, current, directory = await self._client.mget(
            key,
            self._generation_key,
            f"{self._directory_generation_prefix}{vfs_path}",
        )
        if raw is None:
            return ListResult(status=LookupStatus.NOT_FOUND), None
        listing = IndexDirectory.model_validate_json(raw)
        if (
            current is None
            or directory is None
            or listing.generation != f"{_text(current)}:{_text(directory)}"
            or self.clock.now() >= listing.expires_at
        ):
            return ListResult(status=LookupStatus.EXPIRED), None
        if listing.partial:
            return (
                ListResult(
                    partial_entries=listing.entries, version=listing.version
                ),
                listing.expires_at,
            )
        return (
            ListResult(
                entries=listing.entries,
                version=listing.version,
                window=listing.window,
            ),
            listing.expires_at,
        )

    async def set_dir(
        self,
        vfs_path: str,
        entries: Sequence[tuple[str, FileStat]],
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
        entries: Sequence[tuple[str, FileStat]],
        expired_at: datetime | None = None,
    ) -> None:
        await self._set_dir(
            vfs_path, entries, expired_at, partial=True, evict=False
        )

    @_counts_listing_write
    async def _set_dir(
        self,
        vfs_path: str,
        entries: Sequence[tuple[str, FileStat]],
        expired_at: datetime | None,
        *,
        partial: bool,
        evict: bool,
        excluded: tuple[str, ...] = (),
        version: str | None = None,
    ) -> list[Evicted]:
        await self._flush_seed()
        now = datetime.fromtimestamp(self.clock.now(), timezone.utc)
        prefix = "/" if vfs_path == "/" else vfs_path + "/"

        generation = await self._generation(self._generation_key)
        directory_generation = await self._generation(
            f"{self._directory_generation_prefix}{vfs_path}"
        )
        rows: list[tuple[str, str]] = []
        for name, entry in entries:
            rows.append((prefix + name, entry.model_dump_json()))

        expiry = (
            expired_at
            if expired_at is not None
            else now + timedelta(seconds=self._ttl)
        )
        listing = IndexDirectory(
            entries=[path for path, _ in rows],
            folders=[
                int(entry.type is FileType.DIRECTORY) for _, entry in entries
            ],
            expires_at=expiry.timestamp(),
            generation=f"{generation}:{directory_generation}",
            partial=partial,
            version=None if partial else version,
            window=not partial and not evict,
        )
        if not evict:
            await self._eval_complete(
                _WRITE_LISTING,
                [
                    self._children_key(vfs_path),
                    self._tombstone_prefix + vfs_path,
                    self._paths_key,
                    self._generation_key,
                    f"{self._directory_generation_prefix}{vfs_path}",
                ],
                [
                    listing.model_dump_json(),
                    self._entry_prefix,
                    self._children_prefix,
                    self._tombstone_prefix,
                    self._directory_generation_prefix,
                    "[]",
                    uuid7(),
                    *(value for row in rows for value in row),
                ],
            )
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
                    self._generation_key,
                    f"{self._directory_generation_prefix}{vfs_path}",
                ],
                [
                    listing.model_dump_json(),
                    self._entry_prefix,
                    self._children_prefix,
                    self._tombstone_prefix,
                    self._directory_generation_prefix,
                    json.dumps([p.rstrip("/") for p in excluded]),
                    uuid7(),
                    *(value for row in rows for value in row),
                ],
            ),
        )
        dropped: list[Evicted] = []
        for raw, flag in zip(gone, folders):
            key = _text(raw)
            dropped.append(Evicted(key, folder=bool(flag)))
        return dropped

    async def entries(self) -> dict[str, FileStat]:
        await self._flush_seed()
        entries: dict[str, FileStat] = {}
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
                    entries[vfs_path] = _row(raw)
            if cursor == 0:
                return entries

    @_counts_listing_write
    async def invalidate_entry(self, vfs_path: str) -> None:
        await self._flush_seed()
        folder = vfs_path.rsplit("/", 1)[0] or "/"
        await self._eval_complete(
            _DELETE_ENTRY,
            [
                self._paths_key,
                self._children_key(folder),
                self._tombstone_prefix + folder,
                self._generation_key,
                f"{self._directory_generation_prefix}{folder}",
                self._entry_key(vfs_path),
            ],
            [
                self._entry_prefix,
                self._children_prefix,
                self._tombstone_prefix,
                self._directory_generation_prefix,
                vfs_path,
                uuid7(),
            ],
        )

    @_counts_listing_write
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
                    str(REGISTRY_PAGE),
                ],
            )
            cursor = _text(cast(str | bytes, raw))
            if not cursor:
                return

    @_counts_listing_write
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

    async def holds_subtree(self, vfs_path: str) -> bool:
        await self._flush_seed()
        cursor = ""
        while True:
            raw = await self._eval_complete(
                _HOLDS_SUBTREE,
                [self._paths_key],
                [self._children_prefix, vfs_path, cursor, str(REGISTRY_PAGE)],
            )
            found, after = cast(tuple[int, str | bytes], raw)
            if found == 1:
                return True
            cursor = _text(after)
            if not cursor:
                return False

    @_counts_listing_write
    async def invalidate(self) -> None:
        await self._flush_seed()
        # One atomic generation change expires all listings without racing
        # another client's refill or resurrecting a concurrently removed path.
        await self._client.set(self._generation_key, uuid7())

    @_counts_listing_write
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
        self._listings.close()
        if self._owns_client:
            await self._client.aclose()
        await super().close()
