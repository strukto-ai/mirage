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

import type { PostgresAccessor } from '../../accessor/postgres.ts'
import type { ColumnInfo, ForeignKey, IndexInfo, Relationship } from './_client.ts'
import {
  estimatedRowCount,
  fetchAllRelationships,
  fetchColumns,
  fetchForeignKeys,
  fetchIndexes,
  fetchPrimaryKey,
  listMatviews,
  listSchemas,
  listTables,
  listViews,
  tableSizeBytes,
} from './_client.ts'
import { rstripSlash } from '../../utils/slash.ts'

interface DatabaseTable {
  schema: string
  name: string
  row_count_estimate: number
  size_bytes_estimate: number
}

interface DatabaseView {
  schema: string
  name: string
  kind: 'view' | 'materialized'
}

export interface DatabaseJson {
  database: string
  schemas: string[]
  tables: DatabaseTable[]
  views: DatabaseView[]
  relationships: Relationship[]
}

interface EntityColumn extends ColumnInfo {
  primary_key?: boolean
  references?: { schema: string; table: string; column: string }
}

export interface EntitySchemaJson {
  schema: string
  name: string
  kind: string
  columns: EntityColumn[]
  primary_key: string[]
  foreign_keys: ForeignKey[]
  indexes: IndexInfo[]
  row_count_estimate: number
  size_bytes_estimate: number
}

export async function buildDatabaseJson(accessor: PostgresAccessor): Promise<DatabaseJson> {
  const schemas = await listSchemas(accessor, accessor.config.schemas)
  const tables: DatabaseTable[] = []
  const views: DatabaseView[] = []
  for (const s of schemas) {
    for (const t of await listTables(accessor, s)) {
      tables.push({
        schema: s,
        name: t,
        row_count_estimate: await estimatedRowCount(accessor, s, t),
        size_bytes_estimate: await tableSizeBytes(accessor, s, t),
      })
    }
    for (const v of await listViews(accessor, s)) {
      views.push({ schema: s, name: v, kind: 'view' })
    }
    for (const v of await listMatviews(accessor, s)) {
      views.push({ schema: s, name: v, kind: 'materialized' })
    }
  }
  const relationships = await fetchAllRelationships(accessor, schemas)
  return {
    database: databaseNameFromDsn(accessor.config.dsn),
    schemas,
    tables,
    views,
    relationships,
  }
}

export async function buildEntitySchemaJson(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
  kind: string,
): Promise<EntitySchemaJson> {
  const cols = await fetchColumns(accessor, schema, name)
  const pk = await fetchPrimaryKey(accessor, schema, name)
  const fks = await fetchForeignKeys(accessor, schema, name)
  const idx = await fetchIndexes(accessor, schema, name)
  const rows = await estimatedRowCount(accessor, schema, name)
  const size = await tableSizeBytes(accessor, schema, name)

  const pkSet = new Set(pk)
  const fkMap = new Map<string, EntityColumn['references']>()
  for (const fk of fks) {
    const ref = fk.references
    fk.columns.forEach((fromCol, i) => {
      const column = ref.columns[i]
      if (column === undefined) return
      fkMap.set(fromCol, {
        schema: ref.schema,
        table: ref.table,
        column,
      })
    })
  }

  const annotated: EntityColumn[] = cols.map((col) => {
    const out: EntityColumn = { ...col }
    if (pkSet.has(col.name)) out.primary_key = true
    const ref = fkMap.get(col.name)
    if (ref !== undefined) out.references = ref
    return out
  })

  return {
    schema,
    name,
    kind,
    columns: annotated,
    primary_key: pk,
    foreign_keys: fks,
    indexes: idx,
    row_count_estimate: rows,
    size_bytes_estimate: size,
  }
}

export function databaseNameFromDsn(dsn: string): string {
  const stripped = rstripSlash(dsn)
  const lastSegment = stripped.split('/').pop() ?? ''
  const beforeQuery = lastSegment.split('?')[0] ?? ''
  return beforeQuery !== '' ? beforeQuery : 'postgres'
}
