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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { DropboxApiError } from './client.ts'
import { getMetadata, type DropboxEntry } from './api.ts'
import { dropboxPathOf } from './paths.ts'
import { CONTENT_HASH, MISS_SUMMARIES } from './constants.ts'
import { entryToken, tokenOf } from './fingerprint.ts'
import { dropboxPathFromKey, readdir as coreReaddir } from './readdir.ts'
import { enoent, isEnoent } from '../../utils/errors.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'

function statFromEntry(entry: DropboxEntry): FileStat {
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

// API-truthful stat for index-less callers (unlink/rmdir classification,
// the wired find core): get_metadata resolves the entry directly.
async function statFromApi(accessor: DropboxAccessor, path: PathSpec): Promise<FileStat> {
  let entry: DropboxEntry
  try {
    entry = await getMetadata(accessor.tokenManager, dropboxPathOf(accessor, path))
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) {
      throw enoent(path.virtual)
    }
    throw err
  }
  return statFromEntry(entry)
}

// Stat one path with one get_metadata, writing nothing to the index. Only a
// scratch store asks this way, and its callers (the reconcile probe, the drift
// check) treat ENOENT and ENOTDIR alike, so a miss is ENOENT with no further
// lookup. Only a not_found or not_folder 409 is a miss: the probe calls ENOENT
// gone and drops the path's overlay, so a 409 for a file that exists
// (restricted_content, ...) propagates and the probe reads it as unverifiable.
// get_metadata matches case-insensitively where a listing's names are
// exact, so an answer naming the last component in another case is not this
// path.
async function pointStat(
  accessor: DropboxAccessor,
  path: PathSpec,
  key: string,
): Promise<FileStat> {
  let entry: DropboxEntry
  try {
    entry = await getMetadata(
      accessor.tokenManager,
      dropboxPathFromKey(accessor.rootPath, stripSlash(key)),
    )
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

  if (index === undefined) return statFromApi(accessor, path)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    // The throwaway store a fresh probe or the drift check stats through is
    // dropped right after: ask for this one path rather than list a whole
    // folder into it. A mount's own index lists the parent and keeps it, so
    // siblings and repeats cost nothing.
    if (index.scratch) return pointStat(accessor, path, stripSlash(key))
    const parentVirtual = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    try {
      await coreReaddir(
        accessor,
        new PathSpec({
          virtual: parentVirtual,
          directory: parentVirtual,
          resolved: false,
          vfsPath: mountKey(parentVirtual, prefix),
        }),
        index,
      )
    } catch (err) {
      // readdir already maps a genuinely missing path to ENOENT; a listing
      // that fails any other way (ENOTDIR under a file, or a 5xx/429 from
      // the API) is not absence and must surface.
      if (!isEnoent(err)) throw err
    }
    result = await index.get(virtualKey)
    if (result.entry === undefined || result.entry === null) throw enoent(path.virtual)
  }
  if (result.entry.resourceType === 'dropbox/folder') {
    return new FileStat({
      name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { dropbox_id: result.entry.id },
    })
  }
  return new FileStat({
    name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
    size: result.entry.size,
    type: FileType.FILE,
    content: contentTypeForPath(result.entry.vfsName),
    modified: result.entry.remoteTime,
    fingerprint: entryToken(result.entry),
    extra: {
      dropbox_id: result.entry.id,
      resource_type: result.entry.resourceType,
    },
  })
}
