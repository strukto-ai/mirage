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

import type { PathSpec } from '../../types.ts'
import { jsonlBytes } from '../render/json.ts'
import { guardRow, resolveRow } from './resolve.ts'
import type { NotionAccessor } from '../../accessor/notion.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeRead } from '../hierarchy/read.ts'
import {
  normalizeDataSource,
  normalizeDatabase,
  normalizePage,
  normalizeRow,
  toJsonBytes,
} from './normalize.ts'
import { listBlockTree, getDataSource, getDatabase, getPage, queryDataSource } from './pages.ts'
import { stat } from './stat.ts'
import { detectScope } from './scope.ts'

async function readPageJson(
  accessor: NotionAccessor,
  match: ScopeMatch,
  path: PathSpec,
): Promise<Uint8Array> {
  if (match.kind === 'row_json') {
    const page = await resolveRow(accessor, match, path.virtual)
    const blocks = await listBlockTree(accessor.transport, match.slots.row_id ?? '')
    return toJsonBytes(normalizePage(page, blocks))
  }
  await guardRow(accessor, match, path.virtual)
  const pageId = match.slots.page_id ?? ''
  const [page, blocks] = await Promise.all([
    getPage(accessor.transport, pageId),
    listBlockTree(accessor.transport, pageId),
  ])
  return toJsonBytes(normalizePage(page, blocks))
}

async function readDatabaseJson(accessor: NotionAccessor, match: ScopeMatch): Promise<Uint8Array> {
  const database = await getDatabase(accessor.transport, match.slots.database_id ?? '')
  return toJsonBytes(normalizeDatabase(database))
}

async function readDataSourceJson(
  accessor: NotionAccessor,
  match: ScopeMatch,
): Promise<Uint8Array> {
  const dataSource = await getDataSource(accessor.transport, match.slots.data_source_id ?? '')
  return toJsonBytes(normalizeDataSource(dataSource))
}

async function readRowsJsonl(accessor: NotionAccessor, match: ScopeMatch): Promise<Uint8Array> {
  const rows = await queryDataSource(accessor.transport, match.slots.data_source_id ?? '')
  return jsonlBytes(rows.filter((row) => row.object === 'page').map(normalizeRow))
}

export const read = makeRead<NotionAccessor>(
  detectScope,
  {
    page_json: readPageJson,
    row_json: readPageJson,
    database_json: readDatabaseJson,
    data_source_json: readDataSourceJson,
    rows_jsonl: readRowsJsonl,
  },
  { stat },
)
