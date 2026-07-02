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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { IndexEntry, type IndexCacheStore } from '../../cache/index/index.ts'
import { ResourceType } from '../../cache/index/config.ts'
import type { PathSpec } from '../../types.ts'
import { enotdir } from '../../utils/errors.ts'
import { norm } from './utils.ts'

export async function readdir(
  accessor: RAMAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const virtual = path.pattern !== null ? path.directory : path.mountPath
  const mountPrefix = mountPrefixOf(path.virtual, path.resourcePath)
  const virtualKey = mountPrefix + virtual
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) {
      return cached.entries
    }
  }
  const p = norm(virtual)
  if (!accessor.store.dirs.has(p)) {
    throw enotdir(path)
  }
  const dirPrefix = p === '/' ? '/' : `${p}/`
  const seen = new Set<string>()
  const keys = [...accessor.store.files.keys(), ...accessor.store.dirs]
  for (const key of keys) {
    if (key === p) continue
    if (!key.startsWith(dirPrefix)) continue
    const first = key.slice(dirPrefix.length).split('/')[0]
    if (first) seen.add(first)
  }
  const sorted = [...seen].sort()
  const virtualEntries = sorted.map((name) => `${mountPrefix}${dirPrefix}${name}`)
  if (index !== undefined) {
    const fileSet = accessor.store.files
    const entries: [string, IndexEntry][] = sorted.map((name) => {
      const full = `${dirPrefix}${name}`
      const isFile = fileSet.has(full)
      return [
        name,
        new IndexEntry({
          id: full,
          name,
          resourceType: isFile ? ResourceType.FILE : ResourceType.FOLDER,
        }),
      ]
    })
    await index.setDir(virtualKey, entries)
  }
  return virtualEntries
}
