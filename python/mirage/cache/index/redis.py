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
except ModuleNotFoundError as _err:
    if _err.name != "redis":
        raise
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
    parse_row,
    row_json,
)
from mirage.cache.index.constants import (
    CHILDREN_PREFIX,
    DEFAULT_KEY_PREFIX,
    ENTRY_PREFIX,
    FOLDERS_PREFIX,
    FRESH_PREFIX,
    GENERATION_KEY,
    LISTED_PREFIX,
    PATHS_KEY,
    REGISTRY_PAGE,
    TOMBSTONE_PREFIX,
)
from mirage.cache.index.listing_memo import ListingMemo
from mirage.cache.index.store import IndexCacheStore
from mirage.types import FileStat, FileType
from mirage.utils.clock import Clock
from mirage.utils.ids import IdSource, SystemIdSource


def _text(value: str | bytes) -> str:
    return value.decode() if isinstance(value, bytes) else value


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

_LISTING_KEYS = (
    _PATH_RANGE
    + """
-- A listing is four keys under its folder's path: a hash of its fields, its
-- children scored in listing order, the children that are folders, and the
-- children added or turned folder since the listing was last buried.
local function listing_keys(prefix, path)
  local base = string.sub(prefix, 1, -11)
  return prefix .. path, base .. 'listed:' .. path,
    base .. 'folders:' .. path, base .. 'fresh:' .. path
end
-- Each part also holds an empty-string sentinel, so a listing Redis evicted
-- only some keys of reads as gone, never as one that lost children.
local function intact(prefix, path)
  local meta, listed, folders, fresh = listing_keys(prefix, path)
  if redis.call('EXISTS', meta) == 0 then return false end
  if redis.call('ZSCORE', listed, '')
      and redis.call('SISMEMBER', folders, '') == 1
      and redis.call('SISMEMBER', fresh, '') == 1 then
    return true
  end
  redis.call('DEL', meta, listed, folders, fresh)
  return false
end
"""
)

_PATH_REGISTRY = (
    _LISTING_KEYS
    + """
local function track(registry, prefixes, paths)
  for _, path in ipairs(paths) do redis.call('ZADD', registry, 0, path) end
end
local function prune(registry, prefixes, path)
  for _, prefix in ipairs(prefixes) do
    if redis.call('EXISTS', prefix .. path) == 1 then return end
  end
  local _, listed, folders, fresh = listing_keys(prefixes[2], path)
  if redis.call('EXISTS', listed, folders, fresh) > 0 then return end
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
local function drop_listing(prefix, path)
  redis.call('DEL', listing_keys(prefix, path))
end
-- A tombstone scores each child twice its arrival, plus one for a folder,
-- so it keeps the order children were buried in and a folder bit that only
-- ever sets.
local function bury(tomb, path, folder)
  local score = redis.call('ZSCORE', tomb, path)
  if not score then
    redis.call('ZADD', tomb, 2 * redis.call('ZCARD', tomb) + folder, path)
  elseif folder == 1 and tonumber(score) % 2 == 0 then
    redis.call('ZADD', tomb, tonumber(score) + 1, path)
  end
end
-- Bury a listing's children: all of them the first time, then only those
-- added or turned folder since, in listing order. The first burial leaves a
-- sentinel in the tombstone, so one Redis evicted since is buried again
-- whole.
local function bury_listing(prefix, tomb, path)
  if not intact(prefix, path) then return end
  local meta, listed, folders, fresh = listing_keys(prefix, path)
  local children = {}
  if redis.call('HGET', meta, 'buried') == '1'
      and redis.call('ZSCORE', tomb, '') then
    local place = {}
    for _, child in ipairs(redis.call('SMEMBERS', fresh)) do
      local at = child ~= '' and redis.call('ZSCORE', listed, child)
      if at then
        place[child] = tonumber(at)
        children[#children + 1] = child
      end
    end
    table.sort(children, function(a, b) return place[a] < place[b] end)
  else
    children = redis.call('ZRANGE', listed, 1, -1)
  end
  redis.call('DEL', fresh)
  redis.call('SADD', fresh, '')
  for _, child in ipairs(children) do
    bury(tomb, child, redis.call('SISMEMBER', folders, child))
  end
  if #children > 0 and redis.call('HGET', meta, 'buried') ~= '1' then
    redis.call('HSET', meta, 'buried', '1')
    redis.call('ZADD', tomb, '-inf', '')
  elseif #children > 0 and not redis.call('ZSCORE', tomb, '') then
    redis.call('ZADD', tomb, '-inf', '')
  end
end
local function number_children(listed, folders, children, flags)
  for offset = 1, #children, 128 do
    local scored, marked = {}, {}
    for i = offset, math.min(offset + 127, #children) do
      scored[#scored + 1] = i
      scored[#scored + 1] = children[i]
      if flags and flags[i] == 1 then marked[#marked + 1] = children[i] end
    end
    redis.call('ZADD', listed, unpack(scored))
    if #marked > 0 then redis.call('SADD', folders, unpack(marked)) end
  end
end
-- Place a new child before the first one past it in listing order, as a
-- sorted listing keeps it: found by halving when the listing was written
-- sorted, else by walking it. The child takes a score between its
-- neighbours'; scores too close to split are renumbered first.
local function insert_child(listed, path, sorted)
  local last = redis.call('ZCARD', listed) - 1
  local low, high = 1, last + 1
  while sorted and low < high do
    local middle = math.floor((low + high) / 2)
    if redis.call('ZRANGE', listed, middle, middle)[1] > path then
      high = middle
    else
      low = middle + 1
    end
  end
  if not sorted then
    low = last + 1
    local offset = 1
    while offset <= last and low == last + 1 do
      for at, child in ipairs(redis.call('ZRANGE', listed, offset, offset + 255)) do
        if child > path then
          low = offset + at - 1
          break
        end
      end
      offset = offset + 256
    end
  end
  local score
  if last == 0 then
    score = 1
  elseif low == 1 then
    score = tonumber(redis.call('ZRANGE', listed, 1, 1, 'WITHSCORES')[2]) - 1
  elseif low == last + 1 then
    score = tonumber(redis.call('ZRANGE', listed, -1, -1, 'WITHSCORES')[2]) + 1
  else
    local around = redis.call('ZRANGE', listed, low - 1, low, 'WITHSCORES')
    local before, after = tonumber(around[2]), tonumber(around[4])
    score = (before + after) / 2
    if score <= before or score >= after then
      number_children(listed, nil, redis.call('ZRANGE', listed, 1, -1))
      score = low - 0.5
    end
  end
  redis.call('ZADD', listed, score, path)
end
local function write_listing(prefix, path, listing, raw)
  local meta, listed, folders, fresh = listing_keys(prefix, path)
  redis.call('DEL', meta, listed, folders, fresh)
  redis.call('ZADD', listed, '-inf', '')
  redis.call('SADD', folders, '')
  redis.call('SADD', fresh, '')
  local sorted = '1'
  for i = 2, #listing.entries do
    if listing.entries[i - 1] > listing.entries[i] then
      sorted = '0'
      break
    end
  end
  local fields = {
    'expires_at', string.match(raw, '"expires_at"%s*:%s*([%d%.eE%+%-]+)'),
    'generation', listing.generation,
    'partial', listing.partial and '1' or '0',
    'window', listing.window and '1' or '0',
    'sorted', sorted}
  if type(listing.version) == 'string' then
    fields[#fields + 1] = 'version'
    fields[#fields + 1] = listing.version
  end
  redis.call('HSET', meta, unpack(fields))
  number_children(listed, folders, listing.entries, listing.folders)
end
local function publish_listing(
  prefix, path, listing, raw, global_key, directory_key, replacement)
  if replacement ~= '' then
    local current = redis.call('GET', global_key)
    local directory = redis.call('GET', directory_key)
    if current and directory and listing.generation == current .. ':' .. directory then
      listing.generation = current .. ':' .. replacement
    end
    redis.call('SET', directory_key, replacement)
  end
  write_listing(prefix, path, listing, raw)
end
local function unsettle(meta)
  redis.call('HSET', meta, 'partial', '1', 'window', '0')
  redis.call('HDEL', meta, 'version')
end
local function remember_directory(prefix, tombstone_prefix, path)
  path = string.gsub(path, '/+$', '')
  if path == '' then return end
  local parent = string.match(path, '^(.*)/[^/]+$')
  if parent == '' then parent = '/' end
  local _, listed, folders = listing_keys(prefix, parent)
  if intact(prefix, parent) and redis.call('ZSCORE', listed, path) then
    redis.call('SADD', folders, path)
  end
  local tomb = tombstone_prefix .. parent
  local score = redis.call('ZSCORE', tomb, path)
  if score and tonumber(score) % 2 == 0 then
    redis.call('ZADD', tomb, tonumber(score) + 1, path)
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
  for i = offset, last do keys[#keys + 1] = ARGV[5] .. listing.entries[i] end
  local rows = redis.call('MGET', unpack(keys))
  for i = offset, last do
    local row = rows[i - offset + 1]
    listing.folders[i] = (listing.folders[i] == 1
      or redis.call('EXISTS', ARGV[2] .. listing.entries[i]) == 1
      or (row ~= false and is_dir(cjson.decode(row)))) and 1 or 0
  end
end
publish_listing(ARGV[2], ARGV[4], listing, ARGV[1], KEYS[2], KEYS[3], ARGV[6])
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
  bury(KEYS[2], ARGV[1], 1)
  redis.call('ZADD', KEYS[3], 0, ARGV[3])
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
"""
)

_ADD_ENTRY = (
    _LISTING_HISTORY
    + """
local path = string.sub(KEYS[1], #ARGV[7] + 1)
local meta, listed, folders, fresh_children = listing_keys(ARGV[7], path)
local current = redis.call('GET', KEYS[2])
local directory = redis.call('GET', KEYS[3])
intact(ARGV[7], path)
local fields = redis.call('HMGET', meta,
  'generation', 'expires_at', 'buried', 'sorted')
local live = fields[1] and current and directory
  and fields[1] == current .. ':' .. directory
  and tonumber(ARGV[5]) < tonumber(fields[2])
local fresh = cjson.decode(ARGV[4])
if not current or not directory or fresh.generation ~= current .. ':' .. directory then
  redis.call('SET', KEYS[5], ARGV[6])
  if live then
    if redis.call('ZSCORE', listed, ARGV[3]) then
      bury(KEYS[4], ARGV[3], redis.call('SISMEMBER', folders, ARGV[3]))
      redis.call('ZREM', listed, ARGV[3])
      redis.call('SREM', folders, ARGV[3])
    end
    unsettle(meta)
    redis.call('HSET', meta, 'generation', current .. ':' .. ARGV[6])
    redis.call('SET', KEYS[3], ARGV[6])
  end
  return 0
end
local old = redis.call('GET', ARGV[1])
redis.call('SET', KEYS[3], ARGV[6])
local folder = cjson.decode(ARGV[2]).type == 'directory' and 1 or 0
local turned = old and cjson.decode(old).type == 'directory' and folder == 0
if turned then bury(KEYS[4], ARGV[3], 1) end
redis.call('SET', ARGV[1], ARGV[2])
if fields[1] then
  if live then
    redis.call('HSET', meta, 'generation', current .. ':' .. ARGV[6])
    if turned then unsettle(meta) end
    local buried = fields[3] == '1'
    if redis.call('ZSCORE', listed, ARGV[3]) then
      local was = redis.call('SISMEMBER', folders, ARGV[3])
      if was == 1 and folder == 0 then
        bury(KEYS[4], ARGV[3], 1)
        unsettle(meta)
        redis.call('SREM', folders, ARGV[3])
      elseif was == 0 and folder == 1 then
        redis.call('SADD', folders, ARGV[3])
        if buried then redis.call('SADD', fresh_children, ARGV[3]) end
      end
      return 0
    end
    insert_child(listed, ARGV[3], fields[4] == '1')
    if folder == 1 then redis.call('SADD', folders, ARGV[3]) end
    if buried then redis.call('SADD', fresh_children, ARGV[3]) end
    return 1
  end
  bury_listing(ARGV[7], KEYS[4], path)
end
fresh.generation = current .. ':' .. ARGV[6]
write_listing(ARGV[7], path, fresh, ARGV[4])
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
    _LISTING_HISTORY
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
    if ARGV[10] == '1' then bury_listing(ARGV[2], ARGV[3] .. path, path) end
    for _, prefix in ipairs(removed) do
      if prefix == ARGV[2] then
        drop_listing(prefix, path)
      else
        redis.call('DEL', prefix .. path)
      end
    end
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
local path = string.sub(KEYS[2], #ARGV[2] + 1)
track(KEYS[1], prefixes, {path})
local current = redis.call('GET', KEYS[4])
local directory = redis.call('GET', KEYS[5])
local old = redis.call('GET', KEYS[6])
if (old and is_dir(cjson.decode(old)))
  or redis.call('EXISTS', ARGV[2] .. ARGV[5]) == 1 then
  bury(KEYS[3], ARGV[5], 1)
end
local meta, listed, folders = listing_keys(ARGV[2], path)
if intact(ARGV[2], path) then
  local generation = redis.call('HGET', meta, 'generation')
  bury_listing(ARGV[2], KEYS[3], path)
  redis.call('ZREM', listed, ARGV[5])
  redis.call('SREM', folders, ARGV[5])
  if current and directory and generation == current .. ':' .. directory then
    redis.call('HSET', meta, 'generation', current .. ':' .. ARGV[6])
  end
  unsettle(meta)
end
redis.call('SET', KEYS[5], ARGV[6])
redis.call('DEL', KEYS[6])
prune(KEYS[1], prefixes, ARGV[5])
"""
)

_WRITE_LISTING = (
    _LISTING_HISTORY
    + """
if ARGV[8] ~= '' and redis.call('GET', KEYS[4] .. '-observation') ~= ARGV[8] then
  return nil
end
local next = cjson.decode(ARGV[1])
local path = string.sub(KEYS[1], #ARGV[3] + 1)
track(KEYS[3], {ARGV[2], ARGV[3], ARGV[4], ARGV[5]}, {path})
if next.partial then
  bury_listing(ARGV[3], KEYS[2], path)
else
  redis.call('DEL', KEYS[2])
end
for i = 9, #ARGV, 2 do
  if next.partial then
    local old = redis.call('GET', ARGV[2] .. ARGV[i])
    if (old and is_dir(cjson.decode(old)))
      or redis.call('EXISTS', ARGV[3] .. ARGV[i]) == 1 then
      bury(KEYS[2], ARGV[i], 1)
    end
  end
  redis.call('SET', ARGV[2] .. ARGV[i], ARGV[i + 1])
  redis.call('ZADD', KEYS[3], 0, ARGV[i])
end
publish_listing(ARGV[3], path, next, ARGV[1], KEYS[4], KEYS[5], ARGV[7])
remember_directory(ARGV[3], ARGV[4], path)
return 1
"""
)

_SWAP_LISTING = (
    _LISTING_HISTORY
    + """
if ARGV[8] ~= '' and redis.call('GET', KEYS[4] .. '-observation') ~= ARGV[8] then
  return nil
end
if not redis.call('ZSCORE', KEYS[3], '') then
  error('MIRAGE_INDEX_REGISTRY_MISSING')
end
local prefixes = {ARGV[2], ARGV[3], ARGV[4], ARGV[5]}
local path = string.sub(KEYS[1], #ARGV[3] + 1)
track(KEYS[3], prefixes, {path})
local _, listed, folders = listing_keys(ARGV[3], path)
local listing = intact(ARGV[3], path) and redis.call('ZRANGE', listed, 1, -1) or {}
local tomb = redis.call('ZRANGE', KEYS[2], 0, -1, 'WITHSCORES')
redis.call('DEL', KEYS[2])
local excluded = cjson.decode(ARGV[6])
local function protected(child)
  for _, prefix in ipairs(excluded) do
    if child == prefix or string.sub(child, 1, #prefix + 1) == prefix .. '/' then
      return true
    end
  end
  return false
end
local named = {}
for i = 9, #ARGV, 2 do
  named[ARGV[i]] = is_dir(cjson.decode(ARGV[i + 1]))
end
local seen, gone, flags = {}, {}, {}
local function drop(child, buried)
  if seen[child] or protected(child) then
    return
  end
  local row = redis.call('GET', ARGV[2] .. child)
  local folder = buried or redis.call('EXISTS', ARGV[3] .. child) == 1
    or (row ~= false and is_dir(cjson.decode(row)))
  if named[child] ~= nil and not (folder and not named[child]) then
    return
  end
  seen[child] = true
  redis.call('DEL', ARGV[2] .. child)
  prune(KEYS[3], prefixes, child)
  gone[#gone + 1] = child
  flags[#flags + 1] = folder and 1 or 0
end
local buried = {}
for i = 1, #tomb, 2 do
  if tomb[i] ~= '' then
    buried[tomb[i]] = tonumber(tomb[i + 1]) % 2 == 1
  end
end
for _, child in ipairs(listing) do
  drop(child, buried[child] == true
    or redis.call('SISMEMBER', folders, child) == 1)
end
for i = 1, #tomb, 2 do
  if tomb[i] ~= '' then drop(tomb[i], buried[tomb[i]]) end
end
for i = 9, #ARGV, 2 do drop(ARGV[i], false) end
local roots = {}
for i, child in ipairs(gone) do
  if flags[i] == 1 then roots[#roots + 1] = child end
end
local function remove(child)
  if protected(child) then return end
  for _, prefix in ipairs(prefixes) do
    redis.call('DEL', prefix .. child)
  end
  drop_listing(ARGV[3], child)
  redis.call('ZREM', KEYS[3], child)
end
for _, root in ipairs(roots) do
  for _, child in ipairs(subtree(KEYS[3], root)) do remove(child) end
end
for i = 9, #ARGV, 2 do
  redis.call('SET', ARGV[2] .. ARGV[i], ARGV[i + 1])
  redis.call('ZADD', KEYS[3], 0, ARGV[i])
end
publish_listing(
  ARGV[3], path, cjson.decode(ARGV[1]), ARGV[1], KEYS[4], KEYS[5], ARGV[7])
remember_directory(ARGV[3], ARGV[4], path)
return {gone, flags}
"""
)

_BURY_LISTING = (
    _LISTING_HISTORY
    + """
local prefixes = {ARGV[1], ARGV[2], ARGV[3], ARGV[4]}
local path = string.sub(KEYS[1], #ARGV[2] + 1)
track(KEYS[4], prefixes, {path})
local _, listed, folders = listing_keys(ARGV[2], path)
local children = intact(ARGV[2], path) and redis.call('ZRANGE', listed, 1, -1) or {}
for _, child in ipairs(children) do
  local row = redis.call('GET', ARGV[1] .. child)
  local folder = redis.call('SISMEMBER', folders, child) == 1
    or redis.call('EXISTS', ARGV[2] .. child) == 1
    or (row ~= false and is_dir(cjson.decode(row)))
  bury(KEYS[2], child, folder and 1 or 0)
  redis.call('DEL', ARGV[1] .. child)
  prune(KEYS[4], prefixes, child)
end
drop_listing(ARGV[2], path)
redis.call('DEL', KEYS[3])
prune(KEYS[4], prefixes, path)
"""
)

_READ_LISTING = (
    _LISTING_KEYS
    + """
if not intact(ARGV[1], ARGV[2]) then return {} end
local meta, listed = listing_keys(ARGV[1], ARGV[2])
local fields = redis.call('HMGET', meta,
  'generation', 'expires_at', 'partial', 'version', 'window')
local children
if ARGV[3] then
  children = redis.call('ZSCORE', listed, ARGV[3]) and {ARGV[3]} or {}
else
  children = redis.call('ZRANGE', listed, 1, -1)
end
return {fields[1], fields[2], fields[3], fields[4], fields[5],
  redis.call('GET', KEYS[1]), redis.call('GET', KEYS[2]), children}
"""
)

_INVALIDATE_MISSING = (
    _LISTING_KEYS
    + """
local changed, unknown = false, false
local current = redis.call('GET', KEYS[3])
for i = 3, #ARGV do
  local path = ARGV[i]
  local folder = string.match(path, '^(.*)/[^/]+$')
  if folder == '' then folder = '/' end
  local meta, listed = listing_keys(KEYS[1], folder)
  if intact(KEYS[1], folder) then
    local fields = redis.call('HMGET', meta,
      'generation', 'expires_at', 'partial', 'window')
    local directory = redis.call('GET', KEYS[4] .. folder)
    local found = redis.call('ZSCORE', listed, path)
    if not current or not directory
        or fields[1] ~= current .. ':' .. directory
        or tonumber(fields[2]) <= tonumber(ARGV[1]) then
      unknown = true
    elseif fields[3] == '1' or fields[4] == '1' then
      if not found then unknown = true end
    elseif not found then
      redis.call('HSET', meta, 'expires_at', '0')
      redis.call('HDEL', meta, 'version')
      changed = true
    end
  else unknown = true end
end
if changed or unknown then redis.call('SET', KEYS[2], ARGV[2]) end
return changed and 1 or 0
"""
)


class RedisIndexCacheStore(IndexCacheStore):
    """Redis-backed index cache for remote VFS metadata.

    Stores index rows as JSON strings and each listing, empty ones
    included, as keyed structures a write changes one child of.
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
        {key_prefix}mirage:idx:directory:{vfs_path} -> listing fields hash
        {key_prefix}mirage:idx:listed:{vfs_path} -> children, scored in order
        {key_prefix}mirage:idx:folders:{vfs_path} -> children that are folders
        {key_prefix}mirage:idx:fresh:{vfs_path} -> children since the last bury
        {key_prefix}mirage:idx:tombstone:{vfs_path} -> buried children, scored

    Args:
        ttl (float): Default time-to-live in seconds for directory listings.
        url (str): Redis connection URL, used when *client* is not provided.
        client (Redis | None): Pre-existing async Redis client. When given,
            the store will not close it on ``close()``.
        key_prefix (str): Namespace prefix prepended to every Redis key,
            allowing multiple stores to coexist on the same server.
        clock (Clock | None): the clock listing expiries are stamped and
            compared on; None means the system clock.
        ids (IdSource | None): where generation and lease tokens are
            drawn; None means the system source. The tokens only fence
            clients of one server apart, so a seeded source, which mints
            the same tokens on every run, needs a server that is itself
            part of the replayed run.
    """

    def __init__(
        self,
        ttl: float = 600,
        url: str = "redis://localhost:6379/0",
        client: Redis | None = None,
        key_prefix: str = DEFAULT_KEY_PREFIX,
        clock: Clock | None = None,
        ids: IdSource | None = None,
    ) -> None:
        super().__init__(clock)
        self._ids: IdSource = ids if ids is not None else SystemIdSource()
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
            f"{self._key_prefix}{LISTED_PREFIX}",
            f"{self._key_prefix}{FOLDERS_PREFIX}",
            f"{self._key_prefix}{FRESH_PREFIX}",
        )
        for _ in range(3):
            candidate = str(int(self._ids.uuid7().replace("-", "")[-12:], 16))
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
                generation = self._ids.uuid7()
                if not key.startswith(self._directory_generation_prefix):
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

    async def _directory_generations(self, paths: list[str]) -> dict[str, str]:
        if not paths:
            return {}
        keys = [f"{self._directory_generation_prefix}{path}" for path in paths]
        current = await self._client.mget(keys)
        generations = {
            path: _text(token)
            for path, token in zip(paths, current)
            if token is not None
        }
        missing = {
            path: self._ids.uuid7()
            for path in paths
            if path not in generations
        }
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
                    list(last_seed)
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
                        pipe.set(self._entry_key(vfs_path), row_json(entry))
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
                            self._ids.uuid7()
                            if last_seed[vfs_path] == number
                            else "",
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
        return LookupResult(entry=parse_row(raw))

    async def get_many(self, vfs_paths: Sequence[str]) -> dict[str, FileStat]:
        paths = list(dict.fromkeys(vfs_paths))
        if not paths:
            return {}
        await self._flush_seed()
        rows = await self._client.mget(
            [self._entry_key(path) for path in paths]
        )
        return {
            path: parse_row(raw)
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
            row_json(entry),
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
            row_json(entry),
            vfs_path,
            fresh.model_dump_json(),
            str(now.timestamp()),
            self._ids.uuid7(),
            self._children_prefix,
        )
        await pipe.execute()

    async def replace_if_unchanged(
        self, vfs_path: str, predecessor: str, entry: FileStat
    ) -> bool:
        await self._flush_seed()
        key = self._entry_key(vfs_path)
        raw = await self._client.get(key)
        if raw is None or parse_row(raw) != parse_row(predecessor):
            return False
        try:
            result = await cast(
                Awaitable[int],
                self._client.eval(
                    _REPLACE_ENTRY, 1, key, raw, row_json(entry)
                ),
            )
            return result == 1
        finally:
            self._listings.row_wrote(vfs_path)

    async def list_dir(
        self, vfs_path: str, child: str | None = None
    ) -> ListResult:
        """A folder's listing, read from Redis at most once per command.

        Inside a shell command, a later call for the same folder is
        answered from this process's memory while no listing write to
        this key prefix has finished in this process since the read
        began, the read is under LISTING_TRUST_WINDOW seconds old, and
        the listing has not reached its own expiry. A write by another
        process is therefore seen within that window, and by every new
        command at its first read. Outside a command every call reads
        Redis. A lookup of one child reads only that child, unless the
        command looked one up in this folder before.

        Args:
            vfs_path (str): the listed folder's key.
            child (str | None): the key to narrow the entries to.
        """
        return await self._listings.read(
            vfs_path,
            lambda: self._read_listing(vfs_path),
            child,
            None
            if child is None
            else lambda: self._read_listing(vfs_path, child),
        )

    async def _read_listing(
        self, vfs_path: str, child: str | None = None
    ) -> tuple[ListResult, float | None]:
        await self._flush_seed()
        reply = await cast(
            Awaitable[list[Any]],
            self._client.eval(
                _READ_LISTING,
                2,
                self._generation_key,
                f"{self._directory_generation_prefix}{vfs_path}",
                self._children_prefix,
                vfs_path,
                *(() if child is None else (child,)),
            ),
        )
        if not reply:
            return ListResult(status=LookupStatus.NOT_FOUND), None
        (
            generation,
            deadline,
            partial,
            version,
            window,
            current,
            directory,
            children,
        ) = reply
        expires_at = float(_text(deadline))
        if (
            current is None
            or directory is None
            or _text(generation) != f"{_text(current)}:{_text(directory)}"
            or self.clock.now() >= expires_at
        ):
            return ListResult(status=LookupStatus.EXPIRED), None
        entries = [_text(child) for child in children]
        named = None if version is None else _text(version)
        if _text(partial) == "1":
            return (
                ListResult(partial_entries=entries, version=named),
                expires_at,
            )
        return (
            ListResult(
                entries=entries, version=named, window=_text(window) == "1"
            ),
            expires_at,
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
        refill: str | None = None,
    ) -> list[Evicted] | None:
        await self._flush_seed()
        now = datetime.fromtimestamp(self.clock.now(), timezone.utc)
        prefix = "/" if vfs_path == "/" else vfs_path + "/"

        generation = await self._generation(self._generation_key)
        directory_generation = await self._generation(
            f"{self._directory_generation_prefix}{vfs_path}"
        )
        rows: list[tuple[str, str]] = []
        for name, entry in entries:
            rows.append((prefix + name, row_json(entry)))

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
            accepted = await self._eval_complete(
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
                    self._ids.uuid7(),
                    refill or "",
                    *(value for row in rows for value in row),
                ],
            )
            return [] if accepted is not None else None
        # One script, so no other writer lands between reading the previous
        # listing and replacing it; the diff is against the true predecessor.
        result = cast(
            tuple[list[str | bytes], list[int]] | None,
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
                    self._ids.uuid7(),
                    refill or "",
                    *(value for row in rows for value in row),
                ],
            ),
        )
        if result is None:
            return None
        gone, folders = result
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
                    entries[vfs_path] = parse_row(raw)
            if cursor == 0:
                return entries

    async def refill_token(self) -> str:
        await self._flush_seed()
        return await self._generation(self._generation_key + "-observation")

    async def invalidate_missing(self, paths: Sequence[str]) -> bool:
        await self._flush_seed()
        if not paths:
            return False
        if self._listings.allows(paths) and not self._listings.contradicts(
            paths
        ):
            return False
        try:
            changed = bool(
                await cast(
                    Awaitable[int],
                    self._client.eval(
                        _INVALIDATE_MISSING,
                        4,
                        self._children_prefix,
                        self._generation_key + "-observation",
                        self._generation_key,
                        self._directory_generation_prefix,
                        self.clock.now(),
                        self._ids.uuid7(),
                        *paths,
                    ),
                )
            )
        except BaseException:
            self._listings.wrote()
            raise
        if changed or self._listings.contradicts(paths):
            self._listings.wrote()
        return changed

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
                self._ids.uuid7(),
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
        remember: bool = False,
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
                    "1" if remember else "0",
                ],
            )
            cursor = _text(cast(str | bytes, raw))
            if not cursor:
                return

    @_counts_listing_write
    async def invalidate_prefix(
        self,
        vfs_path: str,
        *,
        excluded: tuple[str, ...] = (),
        remember: bool = False,
    ) -> None:
        await self._flush_seed()
        await self._client.set(
            self._generation_key + "-observation", self._ids.uuid7()
        )
        # Tombstones survive until the next complete listing proves removals.
        await self._delete_paths([self._entry_prefix], vfs_path, excluded)
        await self._delete_paths(
            [self._children_prefix, self._directory_generation_prefix],
            vfs_path,
            excluded,
            remember,
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
        await self._client.set(
            self._generation_key + "-observation", self._ids.uuid7()
        )
        await self._flush_seed()
        # One atomic generation change expires all listings without racing
        # another client's refill or resurrecting a concurrently removed path.
        await self._client.set(self._generation_key, self._ids.uuid7())

    @_counts_listing_write
    async def clear(self) -> None:
        await self._client.set(
            self._generation_key + "-observation", self._ids.uuid7()
        )
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
        try:
            await self._flush_seed()
        finally:
            self._listings.close()
        if self._owns_client:
            await self._client.aclose()
        await super().close()
