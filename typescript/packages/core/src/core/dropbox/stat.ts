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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { ListedMiss } from '../../cache/index/config.ts'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { DropboxApiError } from './client.ts'
import { listFolder, lookup, type DropboxEntry } from './api.ts'
import { dropboxPathOf, spelledOtherwise } from './paths.ts'
import { CONTENT_HASH } from './constants.ts'
import { tokenOf } from './fingerprint.ts'
import { readdir as coreReaddir, dropboxPathFromKey } from './readdir.ts'
import { resolveListedEntry } from '../hierarchy/probe.ts'
import { enoent } from '../../errors/fs.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'

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

// One get_metadata: for index-less callers, the fresh checks' store and a
// name missing from a listing the running command did not fetch.
async function statFromApi(accessor: DropboxAccessor, path: PathSpec): Promise<FileStat> {
  const entry = await lookup(accessor.tokenManager, dropboxPathOf(accessor, path))
  if (entry === null || spelledOtherwise(path, entry)) throw enoent(path.virtual)
  return statFromEntry(entry)
}

export async function stat(
  accessor: DropboxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const key = path.vfsPath
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })

  if (index === undefined || index instanceof ListingCheckStore) return statFromApi(accessor, path)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let entry = (await index.get(virtualKey)).entry ?? null
  if (entry === null) {
    const found = await resolveListedEntry(coreReaddir, accessor, path, index)
    if (found === ListedMiss.UNTRUSTED) return statFromApi(accessor, path)
    if (found === null) throw enoent(path.virtual)
    entry = found
  }
  if (entry.resourceType === 'dropbox/folder') {
    return new FileStat({
      name: entry.vfsName !== '' ? entry.vfsName : entry.name,
      type: FileType.DIRECTORY,
      modified: entry.remoteTime,
      extra: { dropbox_id: entry.id },
    })
  }
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    size: entry.size,
    type: FileType.FILE,
    content: contentTypeForPath(entry.vfsName),
    modified: entry.remoteTime,
    fingerprint: tokenOf(entry.extra[CONTENT_HASH]),
    extra: {
      dropbox_id: entry.id,
      resource_type: entry.resourceType,
    },
  })
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
  _index?: IndexCacheStore,
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
