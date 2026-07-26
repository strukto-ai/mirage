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
import type { ColumnInfo, ColumnStats, EnumInfo, ForeignKey } from './_client.ts'
import {
  fetchColumnComments,
  fetchColumns,
  fetchColumnStats,
  fetchEnumColumns,
  fetchForeignKeys,
  fetchPrimaryKey,
  fetchTableComment,
} from './_client.ts'

const SAMPLE_VALUES_LIMIT = 10

const TIME_TYPES: ReadonlySet<string> = new Set([
  'date',
  'time without time zone',
  'time with time zone',
  'timestamp without time zone',
  'timestamp with time zone',
])

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  'bigint',
  'double precision',
  'integer',
  'money',
  'numeric',
  'real',
  'smallint',
])

type ColumnRole = 'dimensions' | 'time_dimensions' | 'facts'

interface ColumnEntry {
  name: string
  expr: string
  data_type: string
  description?: string
  is_enum?: boolean
  sample_values?: string[]
}

interface Relationship {
  left_table: string
  right_table: string
  relationship_columns: { left_column: string; right_column: string }[]
}

export interface EntitySemanticJson {
  name: string
  schema: string
  kind: string
  description?: string
  primary_key?: string[]
  dimensions?: ColumnEntry[]
  time_dimensions?: ColumnEntry[]
  facts?: ColumnEntry[]
  relationships?: Relationship[]
}

// Assign a column its semantic role. Mirrors the dimension / time_dimension /
// fact split of the Snowflake semantic view vocabulary. Keys stay dimensions
// even when numeric: an id is something you group or join by, never sum.
export function classifyColumn(
  name: string,
  dataType: string,
  keyColumns: ReadonlySet<string>,
): ColumnRole {
  if (keyColumns.has(name)) return 'dimensions'
  if (TIME_TYPES.has(dataType)) return 'time_dimensions'
  if (NUMERIC_TYPES.has(dataType)) return 'facts'
  return 'dimensions'
}

// Render one column in the semantic vocabulary. Empty fields are omitted
// rather than emitted as null: the whole point of this artifact is to fit an
// agent's context budget, so absent metadata should cost nothing.
export function buildColumnEntry(
  column: ColumnInfo,
  comment: string | undefined,
  enumInfo: EnumInfo | undefined,
  stats: ColumnStats | undefined,
): ColumnEntry {
  const entry: ColumnEntry = {
    name: column.name,
    expr: column.name,
    data_type: enumInfo ? enumInfo.type : column.type,
  }
  if (comment) entry.description = comment
  if (enumInfo) {
    entry.is_enum = true
    entry.sample_values = enumInfo.labels.slice(0, SAMPLE_VALUES_LIMIT)
  } else if (stats && stats.most_common_vals.length > 0) {
    // most_common_vals is null for high-cardinality columns, so this
    // self-selects the ones where example values actually help.
    entry.sample_values = stats.most_common_vals.slice(0, SAMPLE_VALUES_LIMIT)
  }
  return entry
}

// Render foreign keys as semantic relationships.
export function buildRelationships(
  foreignKeys: readonly ForeignKey[],
  schema: string,
  name: string,
): Relationship[] {
  const relationships: Relationship[] = []
  for (const fk of foreignKeys) {
    const ref = fk.references
    const columns: { left_column: string; right_column: string }[] = []
    fk.columns.forEach((left, i) => {
      const right = ref.columns[i]
      if (right !== undefined) columns.push({ left_column: left, right_column: right })
    })
    relationships.push({
      left_table: `${schema}.${name}`,
      right_table: `${ref.schema}.${ref.table}`,
      relationship_columns: columns,
    })
  }
  return relationships
}

// Build the derived semantic model for one entity. Uses the Snowflake
// semantic view field vocabulary so the artifact is familiar to models and
// interchangeable with a curated one. Everything here is derived from the
// catalog; synonyms, metrics and verified queries have no catalog source and
// are left for a curated overlay.
export async function buildEntitySemanticJson(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
  kind: string,
): Promise<EntitySemanticJson> {
  const columns = await fetchColumns(accessor, schema, name)
  const pk = await fetchPrimaryKey(accessor, schema, name)
  const fks = await fetchForeignKeys(accessor, schema, name)
  const tableComment = await fetchTableComment(accessor, schema, name)
  const comments = await fetchColumnComments(accessor, schema, name)
  const enums = await fetchEnumColumns(accessor, schema, name)
  const stats = await fetchColumnStats(accessor, schema, name)

  const keyColumns = new Set<string>(pk)
  for (const fk of fks) for (const c of fk.columns) keyColumns.add(c)

  const buckets: Record<ColumnRole, ColumnEntry[]> = {
    dimensions: [],
    time_dimensions: [],
    facts: [],
  }
  for (const column of columns) {
    const role = classifyColumn(column.name, column.type, keyColumns)
    buckets[role].push(
      buildColumnEntry(
        column,
        comments.get(column.name),
        enums.get(column.name),
        stats.get(column.name),
      ),
    )
  }

  const doc: EntitySemanticJson = { name, schema, kind }
  if (tableComment) doc.description = tableComment
  if (pk.length > 0) doc.primary_key = pk
  if (buckets.dimensions.length > 0) doc.dimensions = buckets.dimensions
  if (buckets.time_dimensions.length > 0) doc.time_dimensions = buckets.time_dimensions
  if (buckets.facts.length > 0) doc.facts = buckets.facts
  const relationships = buildRelationships(fks, schema, name)
  if (relationships.length > 0) doc.relationships = relationships
  return doc
}
