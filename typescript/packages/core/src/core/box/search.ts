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

import type { BoxAccessor } from '../../accessor/box.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { searchContent, type BoxSearchItem } from './api.ts'
import { BoxApiError } from './client.ts'
import { mountRelativeKey, pathParts, resolveItem } from './resolve.ts'

/**
 * The files under `under` Box content search returns. Each
 * scope is searched with its folder id as `ancestor_folder_ids` and each hit
 * keyed from its `path_collection`. Null whenever the answer may miss a
 * match: an API failure, the 10,000-match ceiling, a scope that no longer
 * resolves to a folder, or no hit at all, since Box indexes a write some time
 * after it lands. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: BoxAccessor,
  text: string,
  under: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  const root = accessor.rootFolderId
  const found: PathSpec[] = []
  for (const p of under) {
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
      const out = await searchContent(accessor.tokenManager, text, folderId)
      if (out.truncated) return null
      results = out.items
    } catch (err) {
      if (!(err instanceof BoxApiError)) throw err
      console.warn(`box search failed (${String(err)}); reading every file`)
      return null
    }
    for (const item of results) {
      const key = mountRelativeKey(item, root)
      if (key) found.push(mountedPath(p, `/${key}`))
    }
  }
  return found.length > 0 ? found : null
}
