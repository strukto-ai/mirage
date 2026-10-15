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

import { stripSlash } from '../../utils/slash.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { DropboxApiError } from './client.ts'
import { getMetadata, listFolder, type DropboxEntry } from './api.ts'
import { dropboxPathOf } from './paths.ts'
import { MISS_SUMMARIES } from './constants.ts'
import { dropboxPathFromKey, statFromEntry } from './readdir.ts'
import { enoent } from '../../errors/fs.ts'

// One get_metadata. Only a not_found or not_folder 409 is a miss; any other
// (restricted_content, ...) names a path that may exist, so a fresh probe must
// not call it gone. get_metadata matches names case-insensitively where a
// listing is exact.
async function statFromApi(accessor: DropboxAccessor, path: PathSpec): Promise<FileStat> {
  let entry: DropboxEntry
  try {
    entry = await getMetadata(accessor.tokenManager, dropboxPathOf(accessor, path))
  } catch (err) {
    if (
      err instanceof DropboxApiError &&
      err.status === 409 &&
      MISS_SUMMARIES.some((miss) => err.summary.startsWith(miss))
    ) {
      throw enoent(path.virtual)
    }
    throw err
  }
  const key = stripSlash(path.vfsPath)
  if (entry.name !== key.slice(key.lastIndexOf('/') + 1)) throw enoent(path.virtual)
  return statFromEntry(entry)
}

/** What is at `path`, asked by its Dropbox path. Mirrors Python's `stat`. */
export async function stat(accessor: DropboxAccessor, path: PathSpec): Promise<FileStat> {
  if (stripSlash(path.vfsPath) === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  return statFromApi(accessor, path)
}

/**
 * Every entry under a folder from one recursive `list_folder`, each as `stat`
 * answers it from a listing. Dropbox matches paths without case, so each
 * entry's place comes from its lowercased path and its name from the entry,
 * as a listing of its folder names it. A folder Dropbox refuses to list (a
 * missing path, a file) resolves null, so the walk's readdir reports it.
 * Mirrors Python's `tree`.
 */
export async function tree(
  accessor: DropboxAccessor,
  path: PathSpec,
): Promise<Map<string, FileStat> | null> {
  const folder = dropboxPathFromKey(accessor.rootPath, stripSlash(path.mountPath))
  let entries: DropboxEntry[]
  try {
    entries = await listFolder(accessor.tokenManager, folder, { recursive: true })
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) return null
    throw err
  }
  const base = folder.toLowerCase().replace(/\/+$/, '')
  const depthOf = (e: DropboxEntry): number => (e.path_lower ?? '').split('/').length
  const places = new Map<string, string>([[base, '']])
  const found = new Map<string, FileStat>()
  for (const entry of [...entries].sort((a, b) => depthOf(a) - depthOf(b))) {
    const lower = entry.path_lower ?? ''
    const parent = lower.slice(0, Math.max(lower.lastIndexOf('/'), 0))
    const above = places.get(parent)
    if (lower === base || above === undefined) continue
    const rel = above === '' ? entry.name : `${above}/${entry.name}`
    places.set(lower, rel)
    found.set(rel, statFromEntry(entry))
  }
  return found
}
