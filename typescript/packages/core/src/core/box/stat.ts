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
import type { BoxAccessor } from '../../accessor/box.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { getFolderInfo, type BoxItem } from './api.ts'
import { readdir as coreReaddir, resourceTypeFor } from './readdir.ts'
import { pathParts, resolveItem } from './resolve.ts'
import { enoent } from '../../utils/errors.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'

function statFromItem(item: BoxItem): FileStat {
  const vfsName = item.name
  const rt = resourceTypeFor(item)
  if (rt === 'box/folder') {
    return new FileStat({
      name: vfsName,
      type: FileType.DIRECTORY,
      modified: item.modified_at ?? '',
      extra: { box_id: item.id },
    })
  }
  const size = typeof item.size === 'number' ? item.size : null
  // Box returns the content sha1 in the same listing, so prefer it: it
  // is content-addressed, where modified_at cannot tell two writes in
  // the same second apart and does not move at all on a re-upload of
  // identical bytes.
  const sha1 = typeof item.sha1 === 'string' && item.sha1 !== '' ? item.sha1 : null
  const modified = item.modified_at ?? ''
  return new FileStat({
    name: vfsName,
    size,
    type: FileType.FILE,
    content: contentTypeForPath(vfsName),
    modified,
    fingerprint: sha1 ?? (modified !== '' ? modified : null),
    extra: { box_id: item.id, resource_type: rt, ...(sha1 === null ? {} : { sha1 }) },
  })
}

export async function stat(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (key === '') {
    // The mount root has no parent listing to inherit an mtime from; fetch
    // the folder's own metadata so find -mtime and ls -ld see a real
    // timestamp (mirrors the onedrive Graph-root stat).
    const info = await getFolderInfo(accessor.tokenManager, accessor.rootFolderId)
    return new FileStat({
      name: '/',
      type: FileType.DIRECTORY,
      modified: info.modified_at ?? '',
      extra: { box_id: accessor.rootFolderId },
    })
  }

  if (index === undefined) {
    // The write-family builders and provision estimation call stat without a
    // threaded index; resolve the id directly rather than ENOENT.
    const item = await resolveItem(accessor, pathParts(path))
    // Weblinks are hidden from listings; a direct lookup must not
    // resurface a sizeless, unreadable entry.
    if (item === null || item.type === 'web_link') throw enoent(path.virtual)
    return statFromItem(item)
  }
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    const parentVirtual = virtualKey.includes('/')
      ? virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
      : '/'
    try {
      await coreReaddir(
        accessor,
        new PathSpec({
          virtual: parentVirtual,
          directory: parentVirtual,
          resolved: false,
          resourcePath: mountKey(parentVirtual, prefix),
        }),
        index,
      )
    } catch {
      // parent listing failed — fall through
    }
    result = await index.get(virtualKey)
    if (result.entry === undefined || result.entry === null) {
      const item = await resolveItem(accessor, pathParts(path))
      if (item === null || item.type === 'web_link') throw enoent(path.virtual)
      return statFromItem(item)
    }
  }
  if (result.entry.resourceType === 'box/folder') {
    return new FileStat({
      name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { box_id: result.entry.id },
    })
  }
  const cachedSha1 = result.entry.extra.sha1
  const sha1 = typeof cachedSha1 === 'string' && cachedSha1 !== '' ? cachedSha1 : null
  return new FileStat({
    name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
    size: result.entry.size,
    type: FileType.FILE,
    content: contentTypeForPath(result.entry.vfsName),
    modified: result.entry.remoteTime,
    fingerprint: sha1 ?? (result.entry.remoteTime !== '' ? result.entry.remoteTime : null),
    extra: {
      box_id: result.entry.id,
      resource_type: result.entry.resourceType,
      ...(sha1 === null ? {} : { sha1 }),
    },
  })
}
