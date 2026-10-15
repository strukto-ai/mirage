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
  const seen = new Set<string>()
  const files = await store.listFiles()
  const dirs = await store.listDirs()
  for (const key of [...files, ...dirs]) {
    if (key === p) continue
    if (!key.startsWith(dirPrefix)) continue
    const remainder = key.slice(dirPrefix.length)
    const first = remainder.split('/')[0]
    if (first !== undefined && first.length > 0) seen.add(dirPrefix + first)
  }
  const fileSet = new Set(files)
  return keyStats(
    store,
    [...seen].sort(compareCodePoints).map((key) => [key, !fileSet.has(key)]),
  )
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
): Promise<Map<string, FileStat> | null> {
  const store = accessor.store
  const p = norm(path.mountPath)
  if (!(await store.hasDir(p))) return null
  const base = rstripSlash(p) + '/'
  const dirs = [...(await store.listDirs())].sort(compareCodePoints)
  const keys: [string, boolean][] = [
    ...(await store.listFiles(base)).map((key): [string, boolean] => [key, false]),
    ...dirs.filter((key) => key.startsWith(base)).map((key): [string, boolean] => [key, true]),
  ].filter(([key]) => key !== p)
  const known = new Set(dirs)
  if (keys.some(([key]) => !known.has(key.slice(0, key.lastIndexOf('/')) || '/'))) return null
  const stats = await keyStats(store, keys)
  const found = new Map<string, FileStat>()
  stats.forEach((st, i) => {
    const key = keys[i]?.[0]
    if (key !== undefined) found.set(key.slice(base.length), st)
  })
  return found
}
