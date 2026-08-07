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

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { LanceRow } from './_driver.ts'
import { PathSpec } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { renderCard } from './render.ts'
import { ScopeLevel, detectScope } from './scope.ts'

function notFound(p: string): Error {
  const err = new Error(p) as Error & { code?: string }
  err.code = 'ENOENT'
  return err
}

function rowFiles(rows: LanceRow[], config: LanceDBAccessor['config']): string[] {
  const names: string[] = []
  for (const row of rows) {
    const id = String(row[config.idColumn])
    names.push(`${id}.md`)
    if (config.blobColumn !== null) names.push(`${id}.${config.blobExt}`)
  }
  return names
}

function rowEntries(rows: LanceRow[], config: LanceDBAccessor['config']): [string, IndexEntry][] {
  // The widened select carries every rendered column, so each card's exact
  // size is free here; blob values are deliberately not fetched at listing
  // time, so blob entries stay size-unknown and stat renders them itself.
  const entries: [string, IndexEntry][] = []
  for (const row of rows) {
    const id = String(row[config.idColumn])
    entries.push([
      `${id}.md`,
      new IndexEntry({
        id,
        name: `${id}.md`,
        resourceType: 'lancedb/row_card',
        vfsName: `${id}.md`,
        size: renderCard(row, config).byteLength,
      }),
    ])
    if (config.blobColumn !== null) {
      const blobName = `${id}.${config.blobExt}`
      entries.push([
        blobName,
        new IndexEntry({
          id,
          name: blobName,
          resourceType: 'lancedb/row_blob',
          vfsName: blobName,
        }),
      ])
    }
  }
  return entries
}

export async function readdir(
  accessor: LanceDBAccessor,
  path: PathSpec | string,
  index?: IndexCacheStore,
): Promise<string[]> {
  const spec = typeof path === 'string' ? PathSpec.fromStrPath(path) : path
  const config = accessor.config
  const scope = detectScope(spec, config)
  const base = rstripSlash(spec.virtual)

  if (scope.level === ScopeLevel.ROOT) {
    const tables = await accessor.driver.listTables()
    return tables.map((name) => `${base}/${name}`)
  }

  if (scope.level === ScopeLevel.GROUP_DIR && scope.table !== null) {
    const depth = Object.keys(scope.filters).length
    const total = config.groupBy.length
    let names: string[]
    if (depth < total) {
      names = await accessor.driver.distinct(
        scope.table,
        config.groupBy[depth] ?? '',
        scope.filters,
        config.maxRows,
      )
    } else {
      // Select every column except the vector and blob ones (schema order,
      // so the projected rows render byte-identically to the full rows
      // read() fetches). Still one data query; the schema lookup is local
      // metadata on the already-opened table.
      const columns = (await accessor.driver.tableColumns(scope.table)).filter(
        (c) => c !== config.vectorColumn && c !== config.blobColumn,
      )
      const rows = await accessor.driver.rowsMatching(
        scope.table,
        scope.filters,
        columns,
        config.maxRows,
      )
      names = rowFiles(rows, config)
      if (index !== undefined) await index.setDir(base, rowEntries(rows, config))
    }
    return names.map((name) => `${base}/${name}`)
  }

  throw notFound(spec.virtual)
}
