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

import type { GoogleApiAccessor } from '../../accessor/google_api.ts'
import { eisdir, enoent, fsError } from '../../errors/fs.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { INVALID, type DetectFn } from '../hierarchy/scope.ts'
import { DATE_LEN, appFilename } from './scope.ts'

/**
 * The title a file name gives a file, null when the listing would render
 * that title under any other name. Mirrors Python's `app_title`.
 */
export function appTitle(
  name: string,
  fileId: string,
  modified: string,
  suffix: string,
): string | null {
  const lead = modified.length >= DATE_LEN ? `${modified.slice(0, DATE_LEN)}_` : ''
  const tail = `__${fileId}${suffix}`
  if (!name.startsWith(lead) || !name.endsWith(tail)) return null
  const title = name.slice(lead.length, name.length - tail.length)
  return appFilename(title, fileId, modified, suffix) === name ? title : null
}

/**
 * The rename of a Google app mount: a new title for a file. A file can take
 * only a name the listing renders back (same folder, date and id); its
 * modified time goes back unchanged, as rename(2) leaves it, and any other
 * name is EPERM. Mirrors Python's `make_app_rename`.
 */
export function makeAppRename(
  detect: DetectFn,
  suffix: string,
): (
  accessor: GoogleApiAccessor,
  src: PathSpec,
  dst: PathSpec,
  entry?: FileStat | null,
) => Promise<void> {
  return async function rename(
    accessor: GoogleApiAccessor,
    src: PathSpec,
    dst: PathSpec,
    entry: FileStat | null = null,
  ): Promise<void> {
    const match = detect(src)
    if (match.kind !== 'file') {
      if (match.kind !== INVALID && !match.scope?.leaf) throw eisdir(src.virtual)
      throw enoent(src.virtual)
    }
    if (entry === null) throw enoent(src.virtual)
    const docId = String(entry.extra.doc_id)
    const drive = accessor.drive
    const modified = (await drive.getFile(docId)).modifiedTime ?? ''
    const cut = dst.virtual.lastIndexOf('/')
    const title = appTitle(dst.virtual.slice(cut + 1), docId, modified, suffix)
    if (
      title === null ||
      dst.virtual.slice(0, cut) !== src.virtual.slice(0, src.virtual.lastIndexOf('/'))
    ) {
      throw fsError(dst, 'EPERM')
    }
    await drive.patchFile(docId, { body: { name: title, modifiedTime: modified } })
  }
}
