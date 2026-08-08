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

import type { IndexCacheStore } from '@struktoai/mirage-core'
import {
  FileStat,
  FileType,
  PathSpec,
  enoent,
  guessType,
  mountKey,
  mountPrefixOf,
} from '@struktoai/mirage-core'
import type { EmailAccessor } from '../../accessor/email.ts'
import { listFolders } from './folders.ts'
import { readdir } from './readdir.ts'

export async function stat(
  accessor: EmailAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = path.resourcePath
  if (key === '') return new FileStat({ name: '/', type: FileType.DIRECTORY })

  if (index === undefined) throw enoent(path.virtual)
  const virtualKey = prefix !== '' ? `${prefix}/${key}` : `/${key}`
  let result = await index.get(virtualKey)
  if (result.entry === undefined || result.entry === null) {
    if (!key.includes('/')) {
      const folders = await listFolders(accessor)
      if (folders.includes(key)) return new FileStat({ name: key, type: FileType.DIRECTORY })
      throw enoent(path.virtual)
    }
    // Cold index: populate by listing the parent, mirroring the python
    // backend's stat fallback.
    const parentVirtual = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
    try {
      await readdir(
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
      throw enoent(path.virtual)
    }
    result = await index.get(virtualKey)
    if (result.entry === undefined || result.entry === null) throw enoent(path.virtual)
  }
  const rt = result.entry.resourceType
  const vfsName = result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name
  if (rt === 'email/folder') return new FileStat({ name: vfsName, type: FileType.DIRECTORY })
  if (rt === 'email/date') return new FileStat({ name: vfsName, type: FileType.DIRECTORY })
  if (rt === 'email/message') {
    return new FileStat({
      name: vfsName,
      type: FileType.JSON,
      size: result.entry.size,
      extra: { uid: result.entry.id },
    })
  }
  if (rt === 'email/attachment_dir') {
    return new FileStat({
      name: vfsName,
      type: FileType.DIRECTORY,
      extra: { uid: result.entry.id },
    })
  }
  if (rt === 'email/attachment') {
    return new FileStat({
      name: vfsName,
      type: guessType(vfsName),
      size: result.entry.size,
      extra: { attachment_id: result.entry.id },
    })
  }
  return new FileStat({ name: vfsName, type: FileType.JSON, extra: { uid: result.entry.id } })
}
