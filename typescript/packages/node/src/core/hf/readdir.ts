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
  IndexEntry,
  ResourceType,
  mountPrefixOf,
  rstripSlash,
  stripSlash,
  type IndexCacheStore,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { HfAccessor } from '../../accessor/hf.ts'
import { SCOPE_ERROR } from './constants.ts'
import { isNotFound } from './util.ts'
import { enoent } from '@struktoai/mirage-core'

export async function readdir(
  accessor: HfAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let target = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && target.startsWith(prefix)) {
    const rest = target.slice(prefix.length)
    if (prefix.endsWith('/') || rest === '' || rest.startsWith('/')) {
      target = rest || '/'
    }
  }
  const virtualKey = rstripSlash(prefix !== '' ? `${prefix}${target}` : target) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
  }
  const strippedTarget = stripSlash(target)
  const listPath = strippedTarget !== '' ? `${strippedTarget}/` : '/'
  const op = await accessor.operator()
  const names: string[] = []
  const dirKeys = new Set<string>()
  const sizes = new Map<string, number | null>()
  let entries
  try {
    entries = await op.list(listPath)
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    throw err
  }
  for (const entry of entries) {
    const relative = entry.path()
    if (relative === '' || relative === listPath) continue
    const isDir = relative.endsWith('/')
    const base = `/${rstripSlash(relative)}`
    names.push(base)
    if (isDir) {
      dirKeys.add(base)
    } else {
      const meta = entry.metadata()
      const length = meta.contentLength
      sizes.set(base, length !== null ? Number(length) : null)
    }
  }
  names.sort()
  if (names.length > SCOPE_ERROR) {
    console.warn(
      `hf readdir: ${virtualKey} returned ${String(names.length)} entries (limit ${String(SCOPE_ERROR)})`,
    )
  }
  const virtualEntries = names.map((e) => (prefix !== '' ? `${prefix}${e}` : e)).sort()
  if (index !== undefined) {
    const indexEntries: [string, IndexEntry][] = names.map((e) => {
      const name = e.split('/').pop() ?? e
      if (dirKeys.has(e)) {
        return [name, new IndexEntry({ id: e, name, resourceType: ResourceType.FOLDER })]
      }
      return [
        name,
        new IndexEntry({
          id: e,
          name,
          resourceType: ResourceType.FILE,
          size: sizes.get(e) ?? null,
        }),
      ]
    })
    await index.setDir(virtualKey, indexEntries)
  }
  return virtualEntries
}
