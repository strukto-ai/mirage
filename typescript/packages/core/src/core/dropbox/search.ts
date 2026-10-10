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

import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { searchFiles } from './api.ts'
import { DropboxApiError } from './client.ts'
import { dropboxPathOf } from './paths.ts'

/**
 * The files under `under` Dropbox search returns. Hits are
 * kept inside each scope on `path_lower` (Dropbox paths are case-insensitive)
 * and keyed from `path_display`. Null whenever the answer may miss a match:
 * an API failure, the 10,000-match ceiling, or no hit at all, since Dropbox
 * indexes a write some time after it lands. Mirrors Python's
 * `files_containing`.
 */
export async function filesContaining(
  accessor: DropboxAccessor,
  text: string,
  under: readonly PathSpec[],
): Promise<PathSpec[] | null> {
  const root = accessor.rootPath
  const found: PathSpec[] = []
  for (const p of under) {
    const scopeApi = dropboxPathOf(accessor, p)
    let results: [string, string][]
    try {
      const out = await searchFiles(accessor.tokenManager, text, { path: scopeApi })
      if (out.truncated) return null
      results = out.paths
    } catch (err) {
      if (!(err instanceof DropboxApiError)) throw err
      console.warn(`dropbox search failed (${String(err)}); reading every file`)
      return null
    }
    const scopeLower = scopeApi.toLowerCase()
    const scopePrefix = rstripSlash(scopeLower) + '/'
    for (const [lower, display] of results) {
      if (lower !== scopeLower && !lower.startsWith(scopePrefix)) continue
      const key = stripSlash(display.slice(root.length))
      if (key) found.push(mountedPath(p, `/${key}`))
    }
  }
  return found.length > 0 ? found : null
}
