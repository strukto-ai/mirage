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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { listingError } from '../../errors/fs.ts'
import { DropboxApiError } from './client.ts'
import { getMetadata, listFolder, type DropboxEntry } from './api.ts'
import { CONTENT_HASH } from './constants.ts'
import { tokenOf } from './fingerprint.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'

export function statFromEntry(entry: DropboxEntry): FileStat {
  const modified = entry.server_modified ?? entry.client_modified ?? ''
  if (entry['.tag'] === 'folder') {
    return new FileStat({
      name: entry.name,
      type: FileType.DIRECTORY,
      modified,
      extra: { dropbox_id: entry.id ?? entry.path_display ?? entry.name },
    })
  }
  return new FileStat({
    name: entry.name,
    size: typeof entry.size === 'number' ? entry.size : null,
    type: FileType.FILE,
    content: contentTypeForPath(entry.name),
    modified,
    fingerprint: tokenOf(entry[CONTENT_HASH]),
    extra: {
      dropbox_id: entry.id ?? entry.path_display ?? entry.name,
      resource_type: 'dropbox/file',
    },
  })
}

export function dropboxPathFromKey(root: string, key: string): string {
  if (key === '') return root
  return `${root}/${key}`
}

async function metadataOrNull(
  accessor: DropboxAccessor,
  key: string,
): Promise<DropboxEntry | null> {
  try {
    return await getMetadata(
      accessor.tokenManager,
      dropboxPathFromKey(accessor.rootPath, stripSlash(key)),
    )
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) return null
    throw err
  }
}

async function isFile(accessor: DropboxAccessor, key: string): Promise<boolean> {
  const entry = await metadataOrNull(accessor, key)
  return entry !== null && entry['.tag'] !== 'folder'
}

async function isDir(accessor: DropboxAccessor, key: string): Promise<boolean> {
  const entry = await metadataOrNull(accessor, key)
  return entry !== null && entry['.tag'] === 'folder'
}

/** A folder's children, each as `stat` answers it. Mirrors Python's `readdir`. */
export async function readdir(accessor: DropboxAccessor, path: PathSpec): Promise<FileStat[]> {
  const key = (path.pattern !== null ? path.dir : path).vfsPath
  const dropboxPath = dropboxPathFromKey(accessor.rootPath, stripSlash(key))
  let files: DropboxEntry[]
  try {
    files = await listFolder(accessor.tokenManager, dropboxPath)
  } catch (err) {
    // list_folder 409s on a missing path and on a file operand alike
    // (path/not_found, path/not_folder), and the subtag cannot tell ENOENT
    // from ENOTDIR either: a path under a file is not_found, where
    // opendir(2) reports Not a directory. So walk the ancestors and let the
    // walk pick the errno, at one request per component on this failure
    // path only.
    if (err instanceof DropboxApiError && err.status === 409) {
      throw await listingError(
        path.virtual,
        key,
        (p) => isFile(accessor, p),
        (p) => isDir(accessor, p),
      )
    }
    throw err
  }
  const rows = files.map(statFromEntry)
  rows.sort((a, b) => compareCodePoints(a.name, b.name))
  return rows
}
