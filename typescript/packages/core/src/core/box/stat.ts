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

import { ListingCheckStore } from '../../cache/index/ram.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { absentOn404, getFileInfo, getFolderInfo, type BoxFileInfo, type BoxItem } from './api.ts'
import { BoxApiError } from './client.ts'
import { SHA1 } from './constants.ts'
import { entryToken, tokenOf } from './fingerprint.ts'
import { readdir as coreReaddir, resourceTypeFor } from './readdir.ts'
import { namesThisPath, pathParts, resolveItem } from './resolve.ts'
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
  const sha1 = tokenOf(item[SHA1])
  return new FileStat({
    name: vfsName,
    size,
    type: FileType.FILE,
    content: contentTypeForPath(vfsName),
    modified: item.modified_at ?? '',
    fingerprint: sha1,
    extra: { box_id: item.id, resource_type: rt, ...(sha1 === null ? {} : { [SHA1]: sha1 }) },
  })
}

/**
 * Stat one file with one request by the id the mount last listed.
 *
 * Only a scratch store asks this way: the reconcile probe builds one over the
 * mount's index, so the cached row is a lead, never an answer. Its id
 * addresses one `GET /files/{id}`, and every field the verdict reads (sha1,
 * name, ancestry, status) comes back live. Anything that is not the active
 * file at exactly this path answers null, and the caller walks the listings
 * as it always has; only that walk may call a path gone, so a 404 or 403
 * here is a fallback, not ENOENT.
 */
async function pointStat(
  accessor: BoxAccessor,
  path: PathSpec,
  index: ListingCheckStore,
  virtualKey: string,
): Promise<FileStat | null> {
  const hint = await index.hint(virtualKey)
  if (hint?.resourceType !== 'box/file' || hint.id === '') return null
  let item: BoxFileInfo
  try {
    item = await getFileInfo(accessor.tokenManager, hint.id)
  } catch (err) {
    if (err instanceof BoxApiError && (err.status === 403 || err.status === 404)) {
      console.warn(`hinted id for ${path.virtual} unusable: ${String(err)}`)
      return null
    }
    throw err
  }
  if (!namesThisPath(accessor, item, path)) return null
  return statFromItem(item)
}

export async function stat(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const key = path.vfsPath
  if (key === '') {
    // The mount root has no parent listing to inherit an mtime from; fetch
    // the folder's own metadata so find -mtime and ls -ld see a real
    // timestamp (mirrors the onedrive Graph-root stat).
    const info = await absentOn404(path.virtual, () =>
      getFolderInfo(accessor.tokenManager, accessor.rootFolderId),
    )
    return new FileStat({
      name: '/',
      type: FileType.DIRECTORY,
      modified: info.modified_at ?? '',
      extra: { box_id: accessor.rootFolderId },
    })
  }

  if (index === undefined) {
    // The write-family builders call stat without a threaded index;
    // resolve the id directly rather than ENOENT.
    const item = await absentOn404(path.virtual, () => resolveItem(accessor, pathParts(path)))
    // Weblinks are hidden from listings; a direct lookup must not
    // resurface a sizeless, unreadable entry.
    if (item === null || item.type === 'web_link') throw enoent(path.virtual)
    return statFromItem(item)
  }
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    if (index instanceof ListingCheckStore) {
      const found = await pointStat(accessor, path, index, virtualKey)
      if (found !== null) return found
    }
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
          vfsPath: mountKey(parentVirtual, prefix),
        }),
        index,
      )
    } catch {
      // parent listing failed — fall through
    }
    result = await index.get(virtualKey)
    if (result.entry === undefined || result.entry === null) {
      const item = await absentOn404(path.virtual, () => resolveItem(accessor, pathParts(path)))
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
  const sha1 = entryToken(result.entry)
  return new FileStat({
    name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
    size: result.entry.size,
    type: FileType.FILE,
    content: contentTypeForPath(result.entry.vfsName),
    modified: result.entry.remoteTime,
    fingerprint: sha1,
    extra: {
      box_id: result.entry.id,
      resource_type: result.entry.resourceType,
      ...(sha1 === null ? {} : { [SHA1]: sha1 }),
    },
  })
}
