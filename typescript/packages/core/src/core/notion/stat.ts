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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { getDatabase } from './pages.ts'
import { parseSegment } from './pathing.ts'
import { enoent } from '../../utils/errors.ts'

export interface NotionStatAccessor {
  readonly transport: NotionTransport
}

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

export async function stat(
  accessor: NotionStatAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const key = path.resourcePath

  if (key === '' || key === 'pages' || key === 'databases') {
    return new FileStat({ name: key !== '' ? key : '/', type: FileType.DIRECTORY })
  }

  const parts = key.split('/')
  const lastSegment = parts[parts.length - 1] ?? ''

  if (lastSegment === 'page.json') {
    return new FileStat({ name: 'page.json', type: FileType.JSON })
  }

  if (lastSegment === 'database.json') {
    if (parts[0] !== 'databases' || parts.length !== 3) throw enoent(path.virtual)
    const databaseSegment = parts[parts.length - 2] ?? ''
    let parsedDatabase: { id: string; title: string }
    try {
      parsedDatabase = parseSegment(databaseSegment)
    } catch {
      throw enoent(path.virtual)
    }
    return new FileStat({
      name: 'database.json',
      type: FileType.JSON,
      extra: { database_id: parsedDatabase.id },
    })
  }

  if (parts[0] === 'databases' && parts.length === 2) {
    let parsedDatabase: { id: string; title: string }
    try {
      parsedDatabase = parseSegment(lastSegment)
    } catch {
      throw enoent(path.virtual)
    }
    if (index !== undefined) {
      const result = await index.get(`/${key}`)
      if (result.entry !== null && result.entry !== undefined) {
        return new FileStat({
          name: result.entry.name,
          type: FileType.DIRECTORY,
          extra: { database_id: parsedDatabase.id },
        })
      }
    }
    const database = await getDatabase(accessor.transport, parsedDatabase.id)
    const modified = pickString(database, 'last_edited_time')
    return new FileStat({
      name: lastSegment,
      type: FileType.DIRECTORY,
      modified: modified === '' ? null : modified,
      extra: { database_id: parsedDatabase.id },
    })
  }

  if (
    (parts[0] === 'pages' && parts.length >= 2) ||
    (parts[0] === 'databases' && parts.length >= 3)
  ) {
    let parsed: { id: string; title: string }
    try {
      parsed = parseSegment(lastSegment)
    } catch {
      throw enoent(path.virtual)
    }
    if (index !== undefined) {
      const result = await index.get(`/${key}`)
      if (result.entry !== null && result.entry !== undefined) {
        return new FileStat({
          name: result.entry.name,
          type: FileType.DIRECTORY,
          modified: result.entry.remoteTime,
          extra: { page_id: parsed.id },
        })
      }
    }
    return new FileStat({
      name: lastSegment,
      type: FileType.DIRECTORY,
      extra: { page_id: parsed.id },
    })
  }

  throw enoent(path.virtual)
}
