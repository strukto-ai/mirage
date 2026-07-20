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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import { PathSpec } from '../../types.ts'
import { rebaseRaw } from '../../utils/path.ts'
import { searchContent, type BoxSearchItem } from './api.ts'
import { pathParts, resolveItem } from './resolve.ts'

function compareComponents(a: string, b: string): number {
  const ca = a.split('/')
  const cb = b.split('/')
  const n = Math.min(ca.length, cb.length)
  for (let i = 0; i < n; i += 1) {
    const x = ca[i] ?? ''
    const y = cb[i] ?? ''
    if (x < y) return -1
    if (x > y) return 1
  }
  return ca.length - cb.length
}

// Reconstruct the mount-relative key from the item's ancestor chain by
// trimming everything up to and including the mount root folder. Box's
// path_collection lists ancestors from the account root down to the immediate
// parent (excluding the item itself).
function mountRelativeKey(item: BoxSearchItem, rootFolderId: string): string | null {
  const entries = item.path_collection?.entries ?? []
  const names: string[] = []
  let collecting = false
  for (const anc of entries) {
    if (collecting) names.push(anc.name)
    if (anc.id === rootFolderId) collecting = true
  }
  if (!collecting) return null
  names.push(item.name)
  return names.filter((n) => n !== '').join('/')
}

/**
 * Use Box content search to narrow grep/rg scopes to candidate files.
 *
 * Each scope is resolved to its Box folder id and searched with that id as
 * the `ancestor_folder_ids` scope; hits are mapped back to mount paths from
 * their `path_collection` ancestor chain, sorted component-wise so they line
 * up with a sorted readdir walk, and each `rawPath` is rebased onto the
 * scope's as-typed spelling so output labels match a walk's.
 *
 * Returns null whenever the narrowed set cannot be trusted as a superset of
 * what a full scan would read (API failure, the 10,000-match ceiling, or a
 * scope that no longer resolves to a folder), so the caller falls back to the
 * full scan.
 */
export async function narrowPaths(
  accessor: BoxAccessor,
  query: string,
  paths: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  const first = paths[0]
  if (first === undefined) return []
  const mountPrefix = mountPrefixOf(first.virtual, first.resourcePath)
  const root = accessor.rootFolderId
  const narrowed: PathSpec[] = []
  for (const p of paths) {
    const parts = pathParts(p)
    let folderId: string
    if (parts.length > 0) {
      const item = await resolveItem(accessor, parts)
      if (item?.type !== 'folder') return null
      folderId = item.id
    } else {
      folderId = root
    }
    let results: BoxSearchItem[]
    try {
      const out = await searchContent(accessor.tokenManager, query, folderId)
      if (out.truncated) return null
      results = out.items
    } catch {
      // Search is best-effort; an API failure falls back to the full scan.
      return null
    }
    const scoped: string[] = []
    for (const item of results) {
      const key = mountRelativeKey(item, root)
      if (key === null) continue
      scoped.push(key === '' ? mountPrefix || '/' : `${mountPrefix}/${key}`)
    }
    scoped.sort(compareComponents)
    for (const virtual of scoped) {
      narrowed.push(
        new PathSpec({
          virtual,
          directory: '',
          resourcePath: mountKey(virtual, mountPrefix),
          resolved: true,
          rawPath: rebaseRaw([virtual], p.virtual, p.rawPath)[0] ?? virtual,
        }),
      )
    }
  }
  return narrowed
}
