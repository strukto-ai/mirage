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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { ListedMiss } from '../../cache/index/config.ts'
import { ListingCheckStore } from '../../cache/index/ram.ts'
import { entryOrListedMiss } from '../../cache/index/warm.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { DropboxApiError } from './client.ts'
import { getMetadata, type DropboxEntry } from './api.ts'
import { dropboxPathOf } from './paths.ts'
import { CONTENT_HASH, MISS_SUMMARIES } from './constants.ts'
import { tokenOf } from './fingerprint.ts'
import { readdir as coreReaddir } from './readdir.ts'
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
// name missing from a listing the running command did not fetch. Only a
// not_found or not_folder 409 is a miss; any other names a path that may
// exist. get_metadata matches names case-insensitively.
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
    const parentVirtual = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    const parent = new PathSpec({
      virtual: parentVirtual,
      directory: parentVirtual,
      resolved: false,
      vfsPath: mountKey(parentVirtual, prefix),
    })
    const found = await entryOrListedMiss(index, virtualKey, () =>
      coreReaddir(accessor, parent, index),
    )
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
