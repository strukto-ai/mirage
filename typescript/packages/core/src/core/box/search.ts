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
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { searchContent, type BoxSearchItem } from './api.ts'
import { BoxApiError } from './client.ts'
import { mountRelativeKey, pathParts } from './resolve.ts'

/**
 * The files under `under` Box content search returns. The scope is searched
 * with its folder id as `ancestor_folder_ids` and each hit keyed from its
 * `path_collection`. Null whenever the answer may miss a match: an API
 * failure, the 10,000-match ceiling, a scope that is not a folder, or no hit
 * at all, since Box indexes a write some time after it lands. `entry` is what
 * is at `under`.
 *
 * Box searches the text it extracted, not the bytes grep reads, so the
 * answer can leave out a file that holds the text: an office file, PDF or
 * archive, the end of a large file, a word Box splits differently
 * (`foo.bar`), or a recent write.
 *
 * Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: BoxAccessor,
  text: string,
  under: PathSpec,
  entry?: FileStat | null,
): Promise<PathSpec[] | null> {
  const root = accessor.rootFolderId
  let folderId: string
  if (pathParts(under).length === 0) folderId = root
  else if (entry?.type !== FileType.DIRECTORY) return null
  else folderId = entry.extra.box_id as string
  let results: BoxSearchItem[]
  try {
    const out = await searchContent(accessor.tokenManager, text, folderId)
    if (out.truncated) return null
    results = out.items
  } catch (err) {
    if (!(err instanceof BoxApiError)) throw err
    console.debug(`box search failed (${String(err)}); reading every file`)
    return null
  }
  const found: PathSpec[] = []
  for (const item of results) {
    const key = mountRelativeKey(item, root)
    if (key) found.push(mountedPath(under, `/${key}`))
  }
  return found.length > 0 ? found : null
}
