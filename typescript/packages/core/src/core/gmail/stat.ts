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
import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { readdir as coreReaddir } from './readdir.ts'
import { listLabels } from './labels.ts'
import { enoent } from '../../utils/errors.ts'

function guessType(name: string): FileType {
  const lower = name.toLowerCase()
  if (lower.endsWith('.json') || lower.endsWith('.gmail.json')) return FileType.JSON
  if (lower.endsWith('.csv')) return FileType.CSV
  if (lower.endsWith('.png')) return FileType.IMAGE_PNG
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return FileType.IMAGE_JPEG
  if (lower.endsWith('.gif')) return FileType.IMAGE_GIF
  if (lower.endsWith('.zip')) return FileType.ZIP
  if (lower.endsWith('.gz') || lower.endsWith('.gzip')) return FileType.GZIP
  if (lower.endsWith('.pdf')) return FileType.PDF
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.log')) {
    return FileType.TEXT
  }
  return FileType.BINARY
}

export async function stat(
  accessor: GmailAccessor,
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
      const labels = await listLabels(accessor.tokenManager)
      const names = new Set(labels.map((lb) => (lb.type === 'system' ? lb.id : (lb.name ?? lb.id))))
      if (names.has(key)) return new FileStat({ name: key, type: FileType.DIRECTORY })
      throw enoent(path.virtual)
    }
    const parentVirtual = virtualKey.slice(0, virtualKey.lastIndexOf('/')) || '/'
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
  const rt = result.entry.resourceType
  const vfsName = result.entry.vfsName !== '' ? result.entry.vfsName : result.entry.name
  if (rt === 'gmail/label') {
    return new FileStat({
      name: vfsName,
      type: FileType.DIRECTORY,
      extra: { label_id: result.entry.id },
    })
  }
  if (rt === 'gmail/date') {
    return new FileStat({ name: vfsName, type: FileType.DIRECTORY })
  }
  if (rt === 'gmail/message') {
    return new FileStat({
      name: vfsName,
      type: FileType.JSON,
      size: result.entry.size,
      extra: { message_id: result.entry.id, ...result.entry.extra },
    })
  }
  if (rt === 'gmail/attachment_dir') {
    return new FileStat({
      name: vfsName,
      type: FileType.DIRECTORY,
      extra: { message_id: result.entry.id },
    })
  }
  if (rt === 'gmail/attachment') {
    return new FileStat({
      name: vfsName,
      type: guessType(vfsName),
      size: result.entry.size,
      extra: { attachment_id: result.entry.id },
    })
  }
  return new FileStat({
    name: vfsName,
    type: FileType.JSON,
    extra: { message_id: result.entry.id },
  })
}
