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
import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { ensureTree } from './tree.ts'
import { enoent } from '../../utils/errors.ts'

export interface ResolvedChromaPath {
  virtualKey: string
  mountPrefix: string
  isDir: boolean
  entry: IndexEntry | null
}

export async function resolvePath(
  accessor: ChromaAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<ResolvedChromaPath> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  if (index === undefined) {
    throw new Error('chroma: missing index')
  }
  const mountPrefix = mountPrefixOf(spec.virtual, spec.resourcePath)
  await ensureTree(accessor, index, mountPrefix)
  const virtualKey = virtualKeyFor(spec)
  const result = await index.get(virtualKey)
  if (result.entry !== undefined && result.entry !== null) {
    return {
      virtualKey,
      mountPrefix,
      isDir: result.entry.resourceType === 'folder',
      entry: result.entry,
    }
  }
  const listing = await index.listDir(virtualKey)
  if (listing.entries !== undefined && listing.entries !== null) {
    return { virtualKey, mountPrefix, isDir: true, entry: null }
  }
  throw enoent(spec.virtual)
}

export function virtualKeyFor(path: PathSpec): string {
  const raw = path.pattern !== null ? path.directory : path.virtual
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  if (prefix !== '') {
    const root = rstripSlash(prefix) !== '' ? rstripSlash(prefix) : '/'
    if (raw === root || raw.startsWith(root + '/')) {
      const trimmed = rstripSlash(raw)
      return trimmed !== '' ? trimmed : root
    }
    const rest = stripSlash(raw)
    if (rest === '') return root
    return root + '/' + rest
  }
  const stripped = stripSlash(raw)
  return stripped !== '' ? '/' + stripped : '/'
}
