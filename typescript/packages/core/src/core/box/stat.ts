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

function guessType(name: string): FileType {
  const lower = name.toLowerCase()
  if (lower.endsWith('.json')) return FileType.JSON
  if (lower.endsWith('.csv')) return FileType.CSV
  if (lower.endsWith('.png')) return FileType.IMAGE_PNG
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return FileType.IMAGE_JPEG
  if (lower.endsWith('.gif')) return FileType.IMAGE_GIF
  if (lower.endsWith('.zip')) return FileType.ZIP
  if (lower.endsWith('.gz') || lower.endsWith('.gzip')) return FileType.GZIP
  if (lower.endsWith('.pdf')) return FileType.PDF
  if (lower.endsWith('.parquet')) return FileType.PARQUET
  if (lower.endsWith('.orc')) return FileType.ORC
  if (lower.endsWith('.feather')) return FileType.FEATHER
  if (lower.endsWith('.h5') || lower.endsWith('.hdf5')) return FileType.HDF5
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log'))
    return FileType.TEXT
  return FileType.BINARY
}

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
  const size = typeof item.size === 'number' && item.size > 0 ? item.size : null
  return new FileStat({
    name: vfsName,
    size,
    type: guessType(vfsName),
    modified: item.modified_at ?? '',
    fingerprint:
      item.modified_at !== undefined && item.modified_at !== '' ? item.modified_at : null,
    extra: { box_id: item.id, resource_type: rt },
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
    if (item === null) throw enoent(path.virtual)
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
      if (item === null) throw enoent(path.virtual)
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
  return new FileStat({
    name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
    size: result.entry.size,
    type: guessType(result.entry.vfsName),
    modified: result.entry.remoteTime,
    fingerprint: result.entry.remoteTime !== '' ? result.entry.remoteTime : null,
    extra: {
      box_id: result.entry.id,
      resource_type: result.entry.resourceType,
    },
  })
}
