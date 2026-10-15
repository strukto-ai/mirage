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

import { rstripSlash } from '../../utils/slash.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { keyStat } from './stat.ts'
import { readdirError } from '../../errors/fs.ts'
import { gnuBasename, norm } from '../../utils/path.ts'
import { compareCodePoints } from '../../utils/sort.ts'

/** The keys of a directory's children, sorted. Mirrors Python's `child_keys`. */
export async function childKeys(accessor: RAMAccessor, path: PathSpec): Promise<string[]> {
  // A pattern spec addresses the directory whose entries the glob filters,
  // and the rest of this function works in mount-relative space, so the
  // directory has to be read off `dir` rather than off the virtual
  // `directory` string (python spells it the same way).
  const target = path.pattern !== null ? path.dir : path
  const p = norm(target.mountPath)
  if (!accessor.store.dirs.has(p)) {
    throw await readdirError(
      path,
      p,
      (k) => accessor.store.files.has(k),
      (k) => accessor.store.dirs.has(k),
    )
  }
  const dirPrefix = p === '/' ? '/' : `${p}/`
  const seen = new Set<string>()
  const keys = [...accessor.store.files.keys(), ...accessor.store.dirs]
  for (const key of keys) {
    if (key === p) continue
    if (!key.startsWith(dirPrefix)) continue
    const first = key.slice(dirPrefix.length).split('/')[0]
    if (first) seen.add(`${dirPrefix}${first}`)
  }
  return [...seen].sort(compareCodePoints)
}

export async function readdir(accessor: RAMAccessor, path: PathSpec): Promise<FileStat[]> {
  // A key restored without its folder still lists the folder.
  return (await childKeys(accessor, path)).map(
    (key) =>
      keyStat(accessor.store, key) ??
      new FileStat({ name: gnuBasename(key), type: FileType.DIRECTORY }),
  )
}

/**
 * Every key under a directory, each as `stat` answers it; null when `path` is
 * no directory, or when a key's parent is none (a file restored without its
 * folder), so the walk's readdir and stat report what is there. Mirrors
 * Python's `tree`.
 */
export function tree(accessor: RAMAccessor, path: PathSpec): Promise<Map<string, FileStat> | null> {
  const store = accessor.store
  const p = norm(path.mountPath)
  if (!store.dirs.has(p)) return Promise.resolve(null)
  const base = rstripSlash(p) + '/'
  const keys = [...store.files.keys(), ...store.dirs].filter(
    (key) => key.startsWith(base) && key !== p,
  )
  if (keys.some((key) => !store.dirs.has(key.slice(0, key.lastIndexOf('/')) || '/'))) {
    return Promise.resolve(null)
  }
  const found = new Map<string, FileStat>()
  for (const key of keys) {
    const entry = keyStat(store, key)
    if (entry !== null) found.set(key.slice(base.length), entry)
  }
  return Promise.resolve(found)
}
