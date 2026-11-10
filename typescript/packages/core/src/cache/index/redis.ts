// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { FileStat } from '../../types.ts'
import { FileType } from '../../types.ts'
import type { Clock } from '../../utils/clock.ts'
import { SystemIdSource, type IdSource } from '../../utils/ids.ts'
import { loadOptionalPeer } from '../../utils/optional_peer.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { globEscape } from '../file/utils.ts'
import { KeyLock } from '../lock.ts'
import {
  type IndexDirectory,
  LookupStatus,
  parseRow,
  rowJson,
  type Evicted,
  type ListResult,
  type LookupResult,
} from './config.ts'
import {
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
} from './constants.ts'
import { ListingMemo } from './listing_memo.ts'
import { IndexCacheStore } from './store.ts'

const REPLACE_ENTRY = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`

const PATH_RANGE = `
local function path_range(root)
  root = string.gsub(root, '/+$', '')
  if root == '' then root = '/' end
  local lower = root == '/' and '/' or root .. '/'
  local upper = root == '/' and '0' or root .. '0'
  return root, lower, upper
end
`

const LISTING_KEYS =
  PATH_RANGE +
  `
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
`

const PATH_REGISTRY =
  LISTING_KEYS +
  `
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
`

const LISTING_HISTORY =
  PATH_REGISTRY +
  `
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
`

const SEED_LISTING =
  LISTING_HISTORY +
  `
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
`

const PUT_ENTRY =
  LISTING_HISTORY +
  `
local old = redis.call('GET', KEYS[1])
if old and cjson.decode(old).type == 'directory'
    and cjson.decode(ARGV[2]).type ~= 'directory' then
  bury(KEYS[2], ARGV[1], 1)
  redis.call('ZADD', KEYS[3], 0, ARGV[3])
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`

const ADD_ENTRY =
  LISTING_HISTORY +
  `
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
`

const TRACK_PATHS =
  PATH_REGISTRY +
  `
local paths = {}
for i = 5, #ARGV do paths[#paths + 1] = ARGV[i] end
track(KEYS[1], {ARGV[1], ARGV[2], ARGV[3], ARGV[4]}, paths)
return 1
`

const RECOVER_PATHS = `
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
`

const DELETE_PATHS =
  LISTING_HISTORY +
  `
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
`

const HOLDS_SUBTREE =
  PATH_RANGE +
  `
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
`

const DELETE_ENTRY =
  LISTING_HISTORY +
  `
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
`

const WRITE_LISTING =
  LISTING_HISTORY +
  `
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
`

const SWAP_LISTING =
  LISTING_HISTORY +
  `
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
`

const BURY_LISTING =
  LISTING_HISTORY +
  `
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
`

const READ_LISTING =
  LISTING_KEYS +
  `
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
`

const INVALIDATE_MISSING =
  LISTING_KEYS +
  `
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
`

interface PendingSeed {
  entries: Map<string, FileStat>
  children: Map<string, string[]>
  expiresAt: number
  version: string | null
}

interface RedisPipeline {
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => RedisPipeline
  set: (key: string, value: string, options?: { NX: boolean }) => RedisPipeline
  del: (key: string) => RedisPipeline
  exec: () => Promise<unknown>
}

export interface RedisClientLike {
  connect: () => Promise<unknown>
  get: (key: string) => Promise<string | null>
  mGet: (keys: string[]) => Promise<(string | null)[]>
  set: (key: string, value: string, options?: { NX: boolean }) => Promise<unknown>
  del: (key: string | string[]) => Promise<unknown>
  multi: () => RedisPipeline
  eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>
  exists: (key: string) => Promise<number>
  scanIterator: (options: { MATCH: string; COUNT?: number }) => AsyncIterable<string | string[]>
  isOpen: boolean
  quit: () => Promise<unknown>
}

// Directory records retain stale listings like RAM; Redis maxmemory eviction
// can still turn any cached fact into a miss. A missing path registry is rebuilt
// in client-side scan batches; prefix invalidation also yields between batches.
export class RedisIndexCacheStore extends IndexCacheStore {
  readonly ttl: number
  private readonly url: string
  private readonly providedClient: RedisClientLike | null
  private readonly entryPrefix: string
  private readonly childrenPrefix: string
  private readonly tombstonePrefix: string
  private readonly keyPrefix: string
  private readonly pathsKey: string
  private readonly generationKey: string
  private readonly initializingGenerations = new Map<string, Promise<string>>()
  private clientPromise: Promise<RedisClientLike> | null = null

  private readonly seedLock = new KeyLock()
  private readonly pendingSeeds: PendingSeed[] = []
  private readonly listings: ListingMemo
  private closed = false
  private readonly ids: IdSource

  constructor(
    options: {
      ttl?: number
      clock?: Clock
      /**
       * Where generation and lease tokens are drawn; the system source by default.
       * The tokens only fence clients of one server apart, so a seeded source,
       * which mints the same tokens on every run, needs a server that is itself
       * part of the replayed run.
       */
      ids?: IdSource
      url?: string
      client?: RedisClientLike
      keyPrefix?: string
    } = {},
  ) {
    super(options.clock)
    this.ids = options.ids ?? new SystemIdSource()
    this.ttl = options.ttl ?? 600
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.providedClient = options.client ?? null
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.keyPrefix = prefix
    this.entryPrefix = `${prefix}${ENTRY_PREFIX}`
    this.childrenPrefix = `${prefix}${CHILDREN_PREFIX}`
    this.tombstonePrefix = `${prefix}${TOMBSTONE_PREFIX}`
    this.generationKey = `${prefix}${GENERATION_KEY}`
    this.pathsKey = `${prefix}${PATHS_KEY}`
    this.listings = new ListingMemo(prefix, this.clock)
  }

  private entryKey(path: string): string {
    return `${this.entryPrefix}${path}`
  }

  private childrenKey(path: string): string {
    return `${this.childrenPrefix}${path}`
  }

  private client(): Promise<RedisClientLike> {
    if (this.providedClient !== null) return Promise.resolve(this.providedClient)
    this.clientPromise ??= (async () => {
      const spec = 'redis'
      const mod = (await loadOptionalPeer(() => import(/* @vite-ignore */ spec), {
        feature: 'RedisIndexCacheStore',
        packageName: 'redis',
      })) as {
        createClient: (o: { url: string; socket?: unknown }) => RedisClientLike
      }
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      })
      await c.connect()
      return c
    })()
    return this.clientPromise
  }

  seed(
    entries: ReadonlyMap<string, FileStat>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
    version: string | null = null,
  ): void {
    this.pendingSeeds.push({
      entries: new Map(entries),
      children: new Map([...children].map(([path, keys]) => [path, [...keys]])),
      expiresAt: expiresAt.getTime() / 1000,
      version,
    })
    this.listings.wrote()
  }

  private trackPaths(pipe: RedisPipeline, paths: readonly string[]): void {
    pipe.eval(TRACK_PATHS, {
      keys: [this.pathsKey],
      arguments: [
        this.entryPrefix,
        this.childrenPrefix,
        this.tombstonePrefix,
        `${this.generationKey}:`,
        ...paths,
      ],
    })
  }

  private async recoverPaths(c: RedisClientLike): Promise<void> {
    const prefixes = [
      this.entryPrefix,
      this.childrenPrefix,
      this.tombstonePrefix,
      `${this.generationKey}:`,
      `${this.keyPrefix}${LISTED_PREFIX}`,
      `${this.keyPrefix}${FOLDERS_PREFIX}`,
      `${this.keyPrefix}${FRESH_PREFIX}`,
    ]
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = String(Number.parseInt(this.ids.uuid7().replaceAll('-', '').slice(-12), 16))
      const [initialStatus, token] = (await c.eval(RECOVER_PATHS, {
        keys: [this.pathsKey],
        arguments: [candidate, 'begin'],
      })) as [number, string]
      let status = initialStatus
      if (status === 1) return
      for await (const batch of c.scanIterator({
        MATCH: `${globEscape(this.keyPrefix)}mirage:idx:*`,
        COUNT: 128,
      })) {
        const rows: string[] = []
        for (const key of Array.isArray(batch) ? batch : [batch]) {
          const prefix = prefixes.find((candidate) => key.startsWith(candidate))
          if (prefix !== undefined) rows.push(key, key.slice(prefix.length))
        }
        for (let start = 0; start < rows.length; start += 256) {
          ;[status] = (await c.eval(RECOVER_PATHS, {
            keys: [this.pathsKey],
            arguments: [token, 'batch', ...rows.slice(start, start + 256)],
          })) as [number, string]
          if (status !== 0) break
        }
        if (status !== 0) break
      }
      if (status === 1) return
      if (status === -1) continue
      ;[status] = (await c.eval(RECOVER_PATHS, {
        keys: [this.pathsKey],
        arguments: [token, 'finish'],
      })) as [number, string]
      if (status === 1) return
    }
    throw new Error('Redis repeatedly evicted the index path registry during recovery')
  }

  private async evalComplete(
    c: RedisClientLike,
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await c.eval(script, options)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes('MIRAGE_INDEX_REGISTRY_MISSING') ||
          attempt === 2
        )
          throw error
        await this.recoverPaths(c)
      }
    }
    throw new Error('Redis index path registry recovery failed')
  }

  private generation(c: RedisClientLike, key: string): Promise<string> {
    const pending = this.initializingGenerations.get(key)
    if (pending !== undefined) return pending
    // Parallel directory refills in this store share one global initializer.
    // Do not retain it afterwards: the next read must observe invalidations.
    const initialized = (async () => {
      const current = await c.get(key)
      if (current !== null) return current
      // A new token after eviction must never revive an old listing.
      const generation = this.ids.uuid7()
      if (!key.startsWith(`${this.generationKey}:`)) {
        await c.set(key, generation, { NX: true })
      } else {
        const pipe = c.multi()
        this.trackPaths(pipe, [key.slice(this.generationKey.length + 1)])
        pipe.set(key, generation, { NX: true })
        await pipe.exec()
      }
      // Even when NX loses, keep our attempted token. A later read could adopt
      // a replacement written by an invalidation/refill and revive old data.
      return generation
    })().finally(() => {
      this.initializingGenerations.delete(key)
    })
    this.initializingGenerations.set(key, initialized)
    return initialized
  }

  private flushSeed(): Promise<void> {
    return this.seedLock.withLock('seed', async () => {
      while (this.pendingSeeds.length > 0) {
        const pending = [...this.pendingSeeds]
        const c = await this.client()
        const generation = await this.generation(c, this.generationKey)
        const directories = new Map<string, string>()
        const lastSeed = new Map<string, number>()
        for (const [number, seed] of pending.entries()) {
          for (const path of seed.children.keys()) lastSeed.set(path, number)
        }
        const paths = [...lastSeed.keys()]
        if (paths.length > 0) {
          const current = await c.mGet(paths.map((path) => `${this.generationKey}:${path}`))
          const missing = new Map<string, string>()
          // Keep observed tokens: rereading them after a concurrent invalidation
          // could stamp the pending snapshot with a replacement generation.
          for (const [i, path] of paths.entries()) {
            const token = current[i]
            if (token == null) missing.set(path, this.ids.uuid7())
            else directories.set(path, token)
          }
          if (missing.size > 0) {
            const initialize = c.multi()
            this.trackPaths(initialize, [...missing.keys()])
            for (const [path, token] of missing) {
              initialize.set(`${this.generationKey}:${path}`, token, { NX: true })
            }
            await initialize.exec()
            for (const [path, token] of missing) directories.set(path, token)
          }
        }
        const rows = new Map(pending.flatMap((seed) => [...seed.entries]))
        const pipe = c.multi()
        this.trackPaths(
          pipe,
          pending.flatMap((seed) => [...seed.entries.keys(), ...seed.children.keys()]),
        )
        for (const [number, seed] of pending.entries()) {
          for (const [path, entry] of seed.entries) {
            pipe.set(this.entryKey(path), rowJson(entry))
          }
          for (const [path, keys] of seed.children) {
            const listing: IndexDirectory = {
              entries: keys,
              folders: keys.map((key) =>
                lastSeed.has(key) || rows.get(key)?.type === FileType.DIRECTORY ? 1 : 0,
              ),
              expires_at: seed.expiresAt,
              generation: `${generation}:${directories.get(path) ?? ''}`,
              partial: false,
              version: seed.version,
              window: false,
            }
            pipe.eval(SEED_LISTING, {
              keys: [this.childrenKey(path), this.generationKey, `${this.generationKey}:${path}`],
              arguments: [
                JSON.stringify(listing),
                this.childrenPrefix,
                this.tombstonePrefix,
                path,
                this.entryPrefix,
                lastSeed.get(path) === number ? this.ids.uuid7() : '',
              ],
            })
          }
        }
        try {
          await pipe.exec()
        } finally {
          this.listings.wrote()
        }
        this.pendingSeeds.splice(0, pending.length)
      }
    })
  }

  async entries(): Promise<Map<string, FileStat>> {
    await this.flushSeed()
    const c = await this.client()
    const entries = new Map<string, FileStat>()
    for await (const batch of c.scanIterator({ MATCH: `${globEscape(this.entryPrefix)}*` })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) {
        const raw = await c.get(key)
        if (raw !== null) entries.set(key.slice(this.entryPrefix.length), parseRow(raw))
      }
    }
    return entries
  }

  async get(vfsPath: string): Promise<LookupResult> {
    await this.flushSeed()
    const c = await this.client()
    const cached = await this.listings.row(vfsPath, (paths) => this.getMany(paths))
    if (cached !== null) return { entry: cached }
    const raw = await c.get(this.entryKey(vfsPath))
    if (raw === null) return { status: LookupStatus.NOT_FOUND }
    return { entry: parseRow(raw) }
  }

  override async getMany(vfsPaths: readonly string[]): Promise<Map<string, FileStat>> {
    const paths = [...new Set(vfsPaths)]
    if (paths.length === 0) return new Map()
    await this.flushSeed()
    const c = await this.client()
    const rows = await c.mGet(paths.map((path) => this.entryKey(path)))
    const found = new Map<string, FileStat>()
    for (const [i, path] of paths.entries()) {
      const raw = rows[i]
      if (raw != null) found.set(path, parseRow(raw))
    }
    return found
  }

  async put(vfsPath: string, entry: FileStat): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    const pipe = c.multi()
    this.trackPaths(pipe, [vfsPath])
    const folder = vfsPath.slice(0, vfsPath.lastIndexOf('/')) || '/'
    pipe.eval(PUT_ENTRY, {
      keys: [this.entryKey(vfsPath), this.tombstonePrefix + folder, this.pathsKey],
      arguments: [vfsPath, rowJson(entry), folder],
    })
    try {
      await pipe.exec()
    } finally {
      this.listings.rowWrote(vfsPath)
    }
  }

  addEntry(vfsPath: string, entry: FileStat, expiredAt?: Date | null): Promise<void> {
    return this.listings.writing(async () => {
      await this.flushSeed()
      const c = await this.client()
      const folder = vfsPath.slice(0, vfsPath.lastIndexOf('/')) || '/'
      const now = new Date(this.clock.now() * 1000)
      const lifetime = now.getTime() + this.ttl * 1000
      const generation = await this.generation(c, this.generationKey)
      const directory = await this.generation(c, `${this.generationKey}:${folder}`)
      const fresh: IndexDirectory = {
        entries: [vfsPath],
        folders: [entry.type === FileType.DIRECTORY ? 1 : 0],
        generation: `${generation}:${directory}`,
        expires_at: (expiredAt == null ? lifetime : Math.min(lifetime, expiredAt.getTime())) / 1000,
        partial: true,
        version: null,
        window: false,
      }
      const pipe = c.multi()
      this.trackPaths(pipe, [folder, vfsPath])
      pipe.eval(ADD_ENTRY, {
        keys: [
          this.childrenKey(folder),
          this.generationKey,
          `${this.generationKey}:${folder}`,
          this.tombstonePrefix + folder,
          `${this.generationKey}:${vfsPath}`,
        ],
        arguments: [
          this.entryKey(vfsPath),
          rowJson(entry),
          vfsPath,
          JSON.stringify(fresh),
          String(now.getTime() / 1000),
          this.ids.uuid7(),
          this.childrenPrefix,
        ],
      })
      await pipe.exec()
    })
  }

  override async replaceIfUnchanged(
    path: string,
    predecessor: string,
    entry: FileStat,
  ): Promise<boolean> {
    await this.flushSeed()
    const c = await this.client()
    const key = this.entryKey(path)
    const raw = await c.get(key)
    if (raw === null || rowJson(parseRow(raw)) !== predecessor) return false
    try {
      const stored = entry
      return (await c.eval(REPLACE_ENTRY, { keys: [key], arguments: [raw, rowJson(stored)] })) === 1
    } finally {
      this.listings.rowWrote(path)
    }
  }

  /**
   * A folder's listing, read from Redis at most once per command.
   *
   * Inside a shell command, a later call for the same folder is answered
   * from this process's memory while no listing write to this key prefix
   * has finished in this process since the read began, the read is under
   * LISTING_TRUST_WINDOW seconds old, and the listing has not reached its
   * own expiry. A write by another process is therefore seen within that
   * window, and by every new command at its first read. Outside a command,
   * and on the fallback storage while more than one command is live, every
   * call reads Redis. On the fallback storage a call outside any command
   * while exactly one command is live is served from that command's memo,
   * under the same write counting and window. A lookup of one child reads
   * only that child, unless the command looked one up in this folder before.
   */
  listDir(vfsPath: string, child?: string): Promise<ListResult> {
    return this.listings.read(
      vfsPath,
      () => this.readListing(vfsPath),
      child,
      child === undefined ? undefined : () => this.readListing(vfsPath, child),
    )
  }

  private async readListing(vfsPath: string, child?: string): Promise<[ListResult, number | null]> {
    await this.flushSeed()
    const c = await this.client()
    const reply = (await c.eval(READ_LISTING, {
      keys: [this.generationKey, `${this.generationKey}:${vfsPath}`],
      arguments: [this.childrenPrefix, vfsPath, ...(child === undefined ? [] : [child])],
    })) as
      | [string, string, string, string | null, string, string | null, string | null, string[]]
      | []
    if (reply.length === 0) return [{ status: LookupStatus.NOT_FOUND }, null]
    const [generation, deadline, partial, version, window, current, directory, children] = reply
    const expiresAt = Number(deadline)
    if (
      current == null ||
      directory == null ||
      generation !== `${current}:${directory}` ||
      this.clock.now() >= expiresAt
    )
      return [{ status: LookupStatus.EXPIRED }, null]
    if (partial === '1') return [{ partialEntries: children, version }, expiresAt]
    return [{ entries: children, version, window: window === '1' }, expiresAt]
  }

  override async setPartialDir(
    vfsPath: string,
    entries: readonly [string, FileStat][],
    expiredAt?: Date | null,
  ): Promise<void> {
    await this.storeDir(vfsPath, entries, expiredAt, true, false)
  }

  protected override storeDir(
    vfsPath: string,
    entries: readonly [string, FileStat][],
    expiredAt: Date | null | undefined,
    partial: boolean,
    evict: boolean,
    excluded: readonly string[] = [],
    version: string | null = null,
    refill: string | null = null,
  ): Promise<Evicted[] | null> {
    return this.listings.writing(async () => {
      await this.flushSeed()
      const c = await this.client()
      const now = new Date(this.clock.now() * 1000)
      const prefix = vfsPath === '/' ? '/' : `${vfsPath}/`
      const generation = await this.generation(c, this.generationKey)
      const directory = await this.generation(c, `${this.generationKey}:${vfsPath}`)
      const rows: [string, string][] = []
      for (const [name, entry] of entries) {
        rows.push([prefix + name, rowJson(entry)])
      }
      const listing: IndexDirectory = {
        entries: rows.map(([path]) => path),
        folders: entries.map(([, entry]) => (entry.type === FileType.DIRECTORY ? 1 : 0)),
        generation: `${generation}:${directory}`,
        expires_at: (expiredAt?.getTime() ?? now.getTime() + this.ttl * 1000) / 1000,
        partial,
        version: partial ? null : version,
        window: !partial && !evict,
      }
      if (!evict) {
        const accepted = await c.eval(WRITE_LISTING, {
          keys: [
            this.childrenKey(vfsPath),
            this.tombstonePrefix + vfsPath,
            this.pathsKey,
            this.generationKey,
            `${this.generationKey}:${vfsPath}`,
          ],
          arguments: [
            JSON.stringify(listing),
            this.entryPrefix,
            this.childrenPrefix,
            this.tombstonePrefix,
            `${this.generationKey}:`,
            '[]',
            this.ids.uuid7(),
            refill ?? '',
            ...rows.flat(),
          ],
        })
        return accepted === null ? null : []
      }
      // One script, so no other writer lands between reading the previous
      // listing and replacing it; the diff is against the true predecessor.
      const result = (await this.evalComplete(c, SWAP_LISTING, {
        keys: [
          this.childrenKey(vfsPath),
          this.tombstonePrefix + vfsPath,
          this.pathsKey,
          this.generationKey,
          `${this.generationKey}:${vfsPath}`,
        ],
        arguments: [
          JSON.stringify(listing),
          this.entryPrefix,
          this.childrenPrefix,
          this.tombstonePrefix,
          `${this.generationKey}:`,
          JSON.stringify(excluded.map(rstripSlash)),
          this.ids.uuid7(),
          refill ?? '',
          ...rows.flat(),
        ],
      })) as [string[], number[]] | null
      if (result === null) return null
      const [gone, folders] = result
      const dropped: Evicted[] = []
      for (const [i, path] of gone.entries()) {
        dropped.push({ path, folder: folders[i] === 1 })
      }
      return dropped
    })
  }

  override async refillToken(): Promise<string> {
    await this.flushSeed()
    return this.generation(await this.client(), `${this.generationKey}-observation`)
  }

  override async invalidateMissing(paths: readonly string[]): Promise<boolean> {
    await this.flushSeed()
    if (paths.length === 0) return false
    if (this.listings.allows(paths) && !this.listings.contradicts(paths)) return false
    let changed: boolean
    try {
      const result = await (
        await this.client()
      ).eval(INVALIDATE_MISSING, {
        keys: [
          this.childrenPrefix,
          `${this.generationKey}-observation`,
          this.generationKey,
          `${this.generationKey}:`,
        ],
        arguments: [String(this.clock.now()), this.ids.uuid7(), ...paths],
      })
      changed = result === 1
    } catch (err) {
      this.listings.wrote()
      throw err
    }
    if (changed || this.listings.contradicts(paths)) this.listings.wrote()
    return changed
  }

  invalidateEntry(vfsPath: string): Promise<void> {
    return this.listings.writing(async () => {
      await this.flushSeed()
      const c = await this.client()
      const folder = vfsPath.slice(0, vfsPath.lastIndexOf('/')) || '/'
      await c.eval(DELETE_ENTRY, {
        keys: [
          this.pathsKey,
          this.childrenKey(folder),
          this.tombstonePrefix + folder,
          this.generationKey,
          `${this.generationKey}:${folder}`,
          this.entryKey(vfsPath),
        ],
        arguments: [
          this.entryPrefix,
          this.childrenPrefix,
          this.tombstonePrefix,
          `${this.generationKey}:`,
          vfsPath,
          this.ids.uuid7(),
        ],
      })
    })
  }

  invalidateDir(vfsPath: string): Promise<void> {
    return this.listings.writing(async () => {
      await this.flushSeed()
      const c = await this.client()
      // The child list becomes a tombstone, so the next complete listing can
      // still tell which children went away.
      await c.eval(BURY_LISTING, {
        keys: [
          this.childrenKey(vfsPath),
          this.tombstonePrefix + vfsPath,
          `${this.generationKey}:${vfsPath}`,
          this.pathsKey,
        ],
        arguments: [
          this.entryPrefix,
          this.childrenPrefix,
          this.tombstonePrefix,
          `${this.generationKey}:`,
        ],
      })
    })
  }

  private async deletePaths(
    prefixes: readonly string[],
    vfsPath: string,
    excluded: readonly string[] = [],
    remember = false,
  ): Promise<void> {
    const c = await this.client()
    let cursor = ''
    do {
      cursor = (await this.evalComplete(c, DELETE_PATHS, {
        keys: [this.pathsKey],
        arguments: [
          this.entryPrefix,
          this.childrenPrefix,
          this.tombstonePrefix,
          `${this.generationKey}:`,
          JSON.stringify(prefixes),
          vfsPath,
          JSON.stringify(excluded.map(rstripSlash)),
          cursor,
          String(REGISTRY_PAGE),
          remember ? '1' : '0',
        ],
      })) as string
    } while (cursor !== '')
  }

  invalidatePrefix(
    vfsPath: string,
    excluded: readonly string[] = [],
    remember = false,
  ): Promise<void> {
    return this.listings.writing(async () => {
      await this.flushSeed()
      await (await this.client()).set(`${this.generationKey}-observation`, this.ids.uuid7())
      // Tombstones survive until the next complete listing proves removals.
      await this.deletePaths([this.entryPrefix], vfsPath, excluded)
      await this.deletePaths(
        [this.childrenPrefix, `${this.generationKey}:`],
        vfsPath,
        excluded,
        remember,
      )
    })
  }

  override async holdsSubtree(vfsPath: string): Promise<boolean> {
    await this.flushSeed()
    const c = await this.client()
    let cursor = ''
    do {
      const [found, after] = (await this.evalComplete(c, HOLDS_SUBTREE, {
        keys: [this.pathsKey],
        arguments: [this.childrenPrefix, vfsPath, cursor, String(REGISTRY_PAGE)],
      })) as [number, string]
      if (found === 1) return true
      cursor = after
    } while (cursor !== '')
    return false
  }

  invalidate(): Promise<void> {
    return this.listings.writing(async () => {
      await this.flushSeed()
      const c = await this.client()
      await c.set(`${this.generationKey}-observation`, this.ids.uuid7())
      // Atomically expire listings without overwriting concurrent refills/deletions.
      await c.set(this.generationKey, this.ids.uuid7())
    })
  }

  clear(): Promise<void> {
    return this.listings.writing(() =>
      this.seedLock.withLock('seed', async () => {
        const client = await this.client()
        await client.set(`${this.generationKey}-observation`, this.ids.uuid7())
        this.pendingSeeds.length = 0
        await this.deletePaths([this.entryPrefix], '/')
        await this.deletePaths(
          [this.childrenPrefix, this.tombstonePrefix, `${this.generationKey}:`],
          '/',
        )
        const c = await this.client()
        await c.del(this.generationKey)
      }),
    )
  }

  override async close(): Promise<void> {
    if (this.closed) return
    try {
      await this.flushSeed()
    } finally {
      this.listings.close()
    }
    if (this.providedClient === null && this.clientPromise !== null) {
      const c = await this.clientPromise
      const typed = c as unknown as { destroy?: () => void }
      if (typeof typed.destroy === 'function') typed.destroy()
      else if (c.isOpen) await c.quit()
      this.clientPromise = null
    }
    this.closed = true
  }
}
