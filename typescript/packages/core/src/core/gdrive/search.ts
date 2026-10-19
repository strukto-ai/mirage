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
import { isFsError } from '../../errors/fs.ts'
import { type FileStat, FileType, type PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { GoogleApiError } from '../google/client.ts'
import { rootContext } from './resolve.ts'
import { PARENTS_PER_QUERY, iterTree } from './tree.ts'

/**
 * The files under `under` Drive full-text search names. The folder is walked
 * by id and Drive is asked which files in the walked folders hold the text.
 * Null when a listing or the search fails or times out, nothing is found,
 * Drive skips a corpus, or the scope is not a folder.
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
  under: PathSpec,
  entry: FileStat | null | undefined,
): Promise<PathSpec[] | null> {
  let root: string
  let driveId: string | null
  if (stripSlash(under.vfsPath) === '') {
    ;[root, driveId] = await rootContext(accessor)
  } else if (entry?.type !== FileType.DIRECTORY) {
    return null
  } else {
    root = entry.extra.file_id as string
    const entryDriveId = entry.extra.drive_id
    driveId = typeof entryDriveId === 'string' ? entryDriveId : null
  }
  const drive = accessor.drive
  const found: PathSpec[] = []
  try {
    const folders = [root]
    const files = new Map<string, PathSpec[]>()
    for await (const [rel, item, isDir] of iterTree(accessor, under, root, driveId)) {
      if (isDir) folders.push(item.id)
      else files.set(item.id, [...(files.get(item.id) ?? []), mountedPath(under, `/${rel}`)])
    }
    for (let start = 0; start < folders.length; start += PARENTS_PER_QUERY) {
      const parents = folders.slice(start, start + PARENTS_PER_QUERY)
      const answer = await drive.searchFiles(text, parents)
      if (!answer.complete) return null
      for (const id of answer.ids) found.push(...(files.get(id) ?? []))
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
