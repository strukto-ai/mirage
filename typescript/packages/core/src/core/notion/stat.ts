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
import { parseSegment } from './pathing.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

export interface NotionStatAccessor {
  readonly transport: NotionTransport
}

export async function stat(
  accessor: NotionStatAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  void accessor
  const prefix = path.prefix
  let p = path.original
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  const key = stripSlash(p)

  if (key === '' || key === 'pages') {
    return new FileStat({ name: key !== '' ? key : '/', type: FileType.DIRECTORY })
  }

  const parts = key.split('/')
  const lastSegment = parts[parts.length - 1] ?? ''

  if (lastSegment === 'page.json') {
    return new FileStat({ name: 'page.json', type: FileType.JSON })
  }

  if (parts.length >= 2 && parts[0] === 'pages') {
    let parsed: { id: string; title: string }
    try {
      parsed = parseSegment(lastSegment)
    } catch {
      throw enoent(path.original)
    }
    if (index !== undefined) {
      const idxKey = `/${key}`
      const result = await index.get(idxKey)
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

  throw enoent(path.original)
}
