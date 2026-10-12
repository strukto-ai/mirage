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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { isFsError } from '../../errors/fs.ts'
import type { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { GoogleApiError } from '../google/client.ts'
import { searchFiles } from '../google/drive.ts'
import { entriesUnder, resolveEntry } from '../hierarchy/probe.ts'
import { DIRECTORY_RESOURCE_TYPES, readdir } from './readdir.ts'
import { rootContext } from './resolve.ts'

export const PARENTS_PER_QUERY = 40

function isFolder(entry: IndexEntry): boolean {
  return DIRECTORY_RESOURCE_TYPES.has(entry.resourceType)
}

async function folderId(
  accessor: GDriveAccessor,
  directory: PathSpec,
  index?: IndexCacheStore,
): Promise<string | null> {
  if (stripSlash(directory.vfsPath) === '') return (await rootContext(accessor))[0]
  const entry = await resolveEntry(readdir, accessor, directory, index)
  return entry !== null && isFolder(entry) ? entry.id : null
}

/**
 * The files under `under` Drive full-text search names. Each scope is walked
 * through the index (the listings grep reads next) and Drive is asked which
 * files in the walked folders hold the text. Null when a listing or the search
 * fails or times out, nothing is found, Drive skips a corpus, or a scope is
 * not a folder.
 *
 * Drive searches the text it extracted, not the bytes grep reads, so the
 * answer can leave out a file that holds the text: a Docs, Sheets or Slides
 * file (its JSON keys and ids), an office file, PDF or archive, the end of a
 * large file, a word Drive splits differently (`foo.bar`), or a recent write.
 * Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: GDriveAccessor,
  text: string,
  under: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[] | null> {
  const found: PathSpec[] = []
  try {
    for (const directory of under) {
      const root = await folderId(accessor, directory, index)
      const walked = await entriesUnder(readdir, accessor, directory, index, isFolder)
      if (root === null || walked === null) return null
      const folders = [root]
      const files = new Map<string, PathSpec[]>()
      for (const [path, entry] of walked) {
        if (isFolder(entry)) folders.push(entry.id)
        else files.set(entry.id, [...(files.get(entry.id) ?? []), path])
      }
      for (let start = 0; start < folders.length; start += PARENTS_PER_QUERY) {
        const parents = folders.slice(start, start + PARENTS_PER_QUERY)
        const answer = await searchFiles(accessor.tokenManager, text, parents)
        if (!answer.complete) return null
        for (const id of answer.ids) found.push(...(files.get(id) ?? []))
      }
    }
  } catch (err) {
    // fetch rejects with a TypeError when the connection fails and a
    // DOMException when its timeout aborts it
    const failed =
      isFsError(err) ||
      err instanceof GoogleApiError ||
      err instanceof TypeError ||
      err instanceof DOMException
    if (!failed) throw err
    console.debug(`drive search failed (${String(err)}); reading every file`)
    return null
  }
  return found.length > 0 ? found : null
}
