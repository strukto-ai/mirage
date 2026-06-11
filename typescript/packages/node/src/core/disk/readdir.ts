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

import type { DiskAccessor } from '../../accessor/disk.ts'
import { readdir as fsReaddir } from 'node:fs/promises'
import {
  IndexEntry,
  type IndexCacheStore,
  type PathSpec,
  ResourceType,
} from '@struktoai/mirage-core'
import { norm } from '@struktoai/mirage-core'
import { resolveSafe } from './utils.ts'

export async function readdir(
  accessor: DiskAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const virtual = path.pattern !== null ? path.directory : path.stripPrefix
  const mountPrefix = path.prefix
  const virtualKey = mountPrefix + virtual
  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) {
      return cached.entries
    }
  }
  const full = resolveSafe(accessor.root, virtual)
  let entries: string[]
  try {
    entries = await fsReaddir(full)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') throw new Error(`not a directory: ${virtual}`)
    if (code === 'ENOENT') throw new Error(`not a directory: ${virtual}`)
    throw err
  }
  const base = norm(virtual)
  const dirPrefix = base === '/' ? '/' : `${base}/`
  const sorted = [...entries].sort()
  const virtualEntries = sorted.map((e) => `${mountPrefix}${dirPrefix}${e}`)
  if (index !== undefined) {
    const indexEntries: [string, IndexEntry][] = sorted.map((name) => [
      name,
      new IndexEntry({
        id: `${dirPrefix}${name}`,
        name,
        resourceType: ResourceType.FILE,
      }),
    ])
    await index.setDir(virtualKey, indexEntries)
  }
  return virtualEntries
}
