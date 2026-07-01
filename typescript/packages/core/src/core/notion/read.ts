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
import type { PathSpec } from '../../types.ts'
import type { NotionTransport } from './_client.ts'
import { normalizeDatabase, normalizePage, toJsonBytes } from './normalize.ts'
import { getBlockTree, getDatabase, getPage } from './pages.ts'
import { parseSegment } from './pathing.ts'
import { enoent } from '../../utils/errors.ts'

export interface NotionReadAccessor {
  readonly transport: NotionTransport
}

export async function read(
  accessor: NotionReadAccessor,
  path: PathSpec,
  _index?: IndexCacheStore,
): Promise<Uint8Array> {
  void _index
  const key = path.key
  if (key === '') throw enoent(path.original)
  const parts = key.split('/')
  const last = parts[parts.length - 1] ?? ''
  if (last !== 'page.json' && last !== 'database.json') throw enoent(path.original)
  if (last === 'database.json') {
    if (parts[0] !== 'databases' || parts.length !== 3) throw enoent(path.original)
    const databaseSegment = parts[parts.length - 2] ?? ''
    let parsedDatabase: { id: string; title: string }
    try {
      parsedDatabase = parseSegment(databaseSegment)
    } catch {
      throw enoent(path.original)
    }
    const database = await getDatabase(accessor.transport, parsedDatabase.id)
    return toJsonBytes(normalizeDatabase(database))
  }
  const isPageJson =
    (parts[0] === 'pages' && parts.length >= 3) || (parts[0] === 'databases' && parts.length >= 4)
  if (!isPageJson) throw enoent(path.original)
  const parentSegment = parts[parts.length - 2] ?? ''
  let parsed: { id: string; title: string }
  try {
    parsed = parseSegment(parentSegment)
  } catch {
    throw enoent(path.original)
  }
  const [page, blocks] = await Promise.all([
    getPage(accessor.transport, parsed.id),
    getBlockTree(accessor.transport, parsed.id),
  ])
  return toJsonBytes(normalizePage(page, blocks))
}
