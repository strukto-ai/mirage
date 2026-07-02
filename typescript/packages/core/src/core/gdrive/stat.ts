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
import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { DIRECTORY_RESOURCE_TYPES, readdir as coreReaddir } from './readdir.ts'
import { enoent } from '../../utils/errors.ts'

function guessType(name: string): FileType {
  const lower = name.toLowerCase()
  if (
    lower.endsWith('.json') ||
    lower.endsWith('.gdoc.json') ||
    lower.endsWith('.gsheet.json') ||
    lower.endsWith('.gslide.json')
  )
    return FileType.JSON
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

export async function stat(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  void accessor
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })

  if (index === undefined) throw enoent(path.virtual)
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
      throw enoent(path.virtual)
    }
  }
  if (DIRECTORY_RESOURCE_TYPES.has(result.entry.resourceType)) {
    return new FileStat({
      name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
      type: FileType.DIRECTORY,
      modified: result.entry.remoteTime,
      extra: { file_id: result.entry.id },
    })
  }
  return new FileStat({
    name: result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name,
    size: result.entry.size,
    type: guessType(result.entry.vfsName),
    modified: result.entry.remoteTime,
    fingerprint: result.entry.remoteTime !== '' ? result.entry.remoteTime : null,
    extra: {
      file_id: result.entry.id,
      resource_type: result.entry.resourceType,
    },
  })
}
