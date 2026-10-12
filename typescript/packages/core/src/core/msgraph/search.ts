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

import type { Accessor } from '../../accessor/base.ts'
import { ResourceType, type IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { entriesUnder, type ReaddirFn } from '../hierarchy/probe.ts'
import { GraphError, graphList } from './client.ts'
import type { MsGraphConfigResolved } from './config.ts'
import type { DriveLoc } from './drive.ts'

function isFolder(entry: IndexEntry): boolean {
  return entry.resourceType === ResourceType.FOLDER
}

/**
 * The files under each scope Graph search names. Each scope is walked through
 * the index (the listings grep reads next) and searched from its folder; a hit
 * counts when its id is a walked file. Null when a listing or the search fails
 * or times out, nothing is found, or a walked file has no id.
 *
 * Graph searches the text it extracted, not the bytes grep reads, so the
 * answer can leave out a file that holds the text: an office file, PDF or
 * archive, the end of a large file, a word Graph splits differently
 * (`foo.bar`), or a recent write. Mirrors Python's `files_containing`.
 */
export async function filesContaining<A extends Accessor>(
  config: MsGraphConfigResolved,
  readdir: ReaddirFn<A>,
  accessor: A,
  scopes: readonly (readonly [PathSpec, DriveLoc])[],
  text: string,
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const quoted = encodeURIComponent(text.replaceAll("'", "''"))
  const found: PathSpec[] = []
  try {
    for (const [directory, loc] of scopes) {
      const walked = await entriesUnder(readdir, accessor, directory, index, isFolder)
      if (walked === null) return null
      const files = new Map<string, PathSpec[]>()
      for (const [path, entry] of walked) {
        if (isFolder(entry)) continue
        const id = entry.extra.id
        if (typeof id !== 'string' || id === '') return null
        files.set(id, [...(files.get(id) ?? []), path])
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
