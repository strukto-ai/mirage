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

import {
  mountPrefixOf,
  type IndexCacheStore,
  type PathSpec,
  rstripSlash,
} from '@struktoai/mirage-core'
import { enotdir } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { RedisIndexEntry } from './entry.ts'
import { norm } from './utils.ts'

export async function readdir(
  accessor: RedisAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const virtual = path.pattern !== null ? path.directory : path.mountPath
  const mountPrefix = mountPrefixOf(path.virtual, path.resourcePath)
  // Canonical key: no trailing slash (except root), or the same dir
  // indexes under two keys and cache hits return doubled-slash entries.
  const virtualKey = rstripSlash(mountPrefix + virtual) || '/'
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) {
      return cached.entries
    }
  }
  const store = accessor.store
  const p = norm(virtual)
  if (!(await store.hasDir(p))) {
    throw enotdir(path)
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
  const sorted = [...seen].sort()
  const virtualEntries = sorted.map((entry) => `${mountPrefix}${entry}`)
  if (index !== undefined) {
    const fileSet = new Set(files)
    const entries: [string, RedisIndexEntry][] = sorted.map((e) => {
      const name = e.slice(e.lastIndexOf('/') + 1)
      return [name, fileSet.has(e) ? RedisIndexEntry.file(e) : RedisIndexEntry.folder(e)]
    })
    await index.setDir(virtualKey, entries)
  }
  return virtualEntries
}
