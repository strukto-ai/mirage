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

import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { GraphError, graphList } from './client.ts'
import type { MsGraphConfigResolved } from './config.ts'
import { type DriveLoc, iterTree } from './drive.ts'

/**
 * The files under each scope Graph search names. Each scope is walked and
 * searched from its folder; a hit counts when its id is a walked file. Null
 * when a listing or the search fails or times out, nothing is found, or a
 * walked file has no id.
 *
 * Graph searches the text it extracted, not the bytes grep reads, so the
 * answer can leave out a file that holds the text: an office file, PDF or
 * archive, the end of a large file, a word Graph splits differently
 * (`foo.bar`), or a recent write. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  config: MsGraphConfigResolved,
  scopes: readonly (readonly [PathSpec, DriveLoc])[],
  text: string,
): Promise<PathSpec[] | null> {
  const quoted = encodeURIComponent(text.replaceAll("'", "''"))
  const found: PathSpec[] = []
  try {
    for (const [directory, loc] of scopes) {
      const files = new Map<string, PathSpec[]>()
      for await (const [virtual, item, folder] of iterTree(config, loc)) {
        if (folder) continue
        const id = item.id
        if (typeof id !== 'string' || id === '') return null
        files.set(id, [...(files.get(id) ?? []), mountedPath(directory, `/${virtual}`)])
      }
      const items = await graphList(config, loc.item(`/search(q='${quoted}')`), { $select: 'id' })
      for (const item of items) {
        if (typeof item.id === 'string') found.push(...(files.get(item.id) ?? []))
      }
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it
    const failed =
      isFsError(err) ||
      err instanceof GraphError ||
      err instanceof TypeError ||
      err instanceof DOMException
    if (!failed) throw err
    console.debug(`graph search failed (${String(err)}); reading every file`)
    return null
  }
  return found.length > 0 ? found : null
}
