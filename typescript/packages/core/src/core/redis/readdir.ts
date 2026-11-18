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

import type { FileStat, PathSpec } from '../../types.ts'
import { commandKey } from '../../cache/index/scope.ts'
import { sortedPrefix } from '../../utils/key_prefix.ts'
import { keyStats } from './stat.ts'
import { readdirError } from '../../errors/fs.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm } from '../../utils/path.ts'

export async function readdir(accessor: RedisAccessor, path: PathSpec): Promise<FileStat[]> {
  // A pattern spec addresses the directory whose entries the glob filters,
  // and the rest of this function works in mount-relative space, so the
  // directory has to be read off `dir` rather than off the virtual
  // `directory` string (python strips the prefix by hand for the same
  // reason).
  const target = path.pattern !== null ? path.dir : path
  const store = accessor.store
  const p = norm(target.mountPath)
  if (!(await store.hasDir(p))) {
    throw await readdirError(
      path,
      p,
      (k) => store.hasFile(k),
      (k) => store.hasDir(k),
    )
  }
  const dirPrefix = p === '/' ? '/' : `${p}/`
  const seen = new Map<string, boolean>()
  for await (const [key, isDir] of walkPaths(accessor, dirPrefix)) {
    const slash = key.indexOf('/', dirPrefix.length)
    const child = slash === -1 ? key : key.slice(0, slash)
    if (child.length > dirPrefix.length) {
      seen.set(child, (seen.get(child) ?? true) && (slash !== -1 || isDir))
    }
  }
  return keyStats(
    store,
    [...seen].sort(([a], [b]) => compareCodePoints(a, b)),
  )
}

async function* scanPaths(
  accessor: RedisAccessor,
  base: string,
): AsyncGenerator<[string, boolean]> {
  const { store } = accessor
  if (store.scanPaths !== undefined) {
    try {
      yield* store.scanPaths(base)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (!/\bsscan\b/i.test(message) || !/\b(?:noperm|unknown command)\b/i.test(message))
        throw error
      console.debug('Redis directory scan unavailable:', error)
    }
  } else {
    for (const key of await store.listFiles(base)) yield [key, false]
  }
  for (const key of await store.listDirs()) if (key.startsWith(base)) yield [key, true]
}

/** Reuse a single paged list of names when a bounded snapshot sends this command back to the walk. */
async function* walkPaths(
  accessor: RedisAccessor,
  base: string,
): AsyncGenerator<[string, boolean]> {
  const scope = commandKey()
  const walk = scope === null ? undefined : accessor.walks.get(scope)
  if (walk !== undefined && base.startsWith(walk.base)) {
    if (walk.names === null) {
      const names: string[] = []
      for await (const [key, isDir] of scanPaths(accessor, walk.base))
        names.push(isDir ? key + '/' : key)
      walk.names = names.sort(compareCodePoints)
    }
    for (const name of sortedPrefix(walk.names, base)) {
      yield name.endsWith('/') ? [name.slice(0, -1), true] : [name, false]
    }
  } else {
    yield* scanPaths(accessor, base)
  }
}

/**
 * Every key under a directory from one scan, each as `stat` answers it,
 * fetched in one pipeline; null when `path` is no directory, or when a key's
 * parent is none (a file another client left without its folder), so the
 * walk's readdir and stat report what is there. Mirrors Python's `tree`.
 */
export async function tree(
  accessor: RedisAccessor,
  path: PathSpec,
  limit?: number,
): Promise<Map<string, FileStat> | null> {
  const store = accessor.store
  const p = norm(path.mountPath)
  if (!(await store.hasDir(p))) return null
  const base = rstripSlash(p) + '/'
  let keys: [string, boolean][]
  let known: Set<string>
  if (limit === undefined) {
    known = await store.listDirs()
    keys = [
      ...(await store.listFiles(base)).map((key): [string, boolean] => [key, false]),
      ...[...known]
        .sort(compareCodePoints)
        .filter((key) => key.startsWith(base) && key !== p)
        .map((key): [string, boolean] => [key, true]),
    ]
  } else {
    if (store.scanPaths === undefined) return null
    const found = new Map<string, boolean>()
    for await (const [key, isDir] of walkPaths(accessor, base)) {
      if (key === p) continue
      if (!found.has(key) && found.size >= limit) {
        const scope = commandKey()
        if (scope !== null) {
          const walk = accessor.walks.get(scope)
          if (walk === undefined || !base.startsWith(walk.base))
            accessor.walks.set(scope, { base, names: null })
        }
        return null
      }
      found.set(key, isDir)
    }
    keys = [...found].sort(([a], [b]) => compareCodePoints(a, b))
    known = new Set([p, ...keys.filter(([, isDir]) => isDir).map(([key]) => key)])
  }
  if (keys.some(([key]) => !known.has(key.slice(0, key.lastIndexOf('/')) || '/'))) return null
  const stats = await keyStats(store, keys)
  const found = new Map<string, FileStat>()
  stats.forEach((st, i) => {
    const key = keys[i]?.[0]
    if (key !== undefined) found.set(key.slice(base.length), st)
  })
  return found
}
