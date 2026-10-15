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

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
}

export interface ForeignKey {
  columns: string[]
  references: { schema: string; table: string; columns: string[] }
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
}

export interface Relationship {
  from: { schema: string; table: string; columns: string[] }
  to: { schema: string; table: string; columns: string[] }
  kind: 'many_to_one'
}

export interface EnumInfo {
  type: string
  labels: string[]
}

export interface ColumnStats {
  n_distinct: number
  most_common_vals: string[]
}

export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`
}

export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

export async function listSchemas(
  accessor: PostgresAccessor,
  allowlist: readonly string[] | null,
): Promise<string[]> {
  const result = await accessor.store.query<{ schema_name: string }>(
    'SELECT schema_name FROM information_schema.schemata ' +
      "WHERE schema_name NOT IN ('pg_catalog', 'information_schema') " +
      "AND schema_name NOT LIKE 'pg_%' " +
      'ORDER BY schema_name',
  )
  let names = result.rows.map((r) => r.schema_name)
  if (allowlist !== null) {
    const allow = new Set(allowlist)
    names = names.filter((n) => allow.has(n))
  }
  return names
}

export async function listTables(accessor: PostgresAccessor, schema: string): Promise<string[]> {
  const result = await accessor.store.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables ' +
      "WHERE table_schema = $1 AND table_type = 'BASE TABLE' " +
      'ORDER BY table_name',
    [schema],
  )
  return result.rows.map((r) => r.table_name)
}

export async function listViews(accessor: PostgresAccessor, schema: string): Promise<string[]> {
  const result = await accessor.store.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.views ' +
      'WHERE table_schema = $1 ' +
      'ORDER BY table_name',
    [schema],
  )
  return result.rows.map((r) => r.table_name)
}

export async function listMatviews(accessor: PostgresAccessor, schema: string): Promise<string[]> {
  const result = await accessor.store.query<{ name: string }>(
    'SELECT matviewname AS name FROM pg_matviews ' +
      'WHERE schemaname = $1 ' +
      'ORDER BY matviewname',
    [schema],
  )
  return result.rows.map((r) => r.name)
}

export async function countRows(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<number> {
  const result = await accessor.store.query<{ count: string | number }>(
    `SELECT COUNT(*) AS count FROM ${qualified(schema, name)}`,
  )
  const value = result.rows[0]?.count ?? 0
  return Number(value)
}

export async function estimateSize(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<[number, number]> {
  const result = await accessor.store.query(
    `EXPLAIN (FORMAT JSON) SELECT * FROM ${qualified(schema, name)}`,
  )
  let plan: unknown = Object.values(result.rows[0] ?? {})[0]
  if (typeof plan === 'string') plan = JSON.parse(plan)
  const top = (plan as { Plan: Record<string, unknown> }[])[0]?.Plan ?? {}
  const rows = Number(top['Plan Rows'] ?? 0) | 0
  const width = Number(top['Plan Width'] ?? 0) | 0
  return [rows, width]
}

export async function estimatedRowCount(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<number> {
  const result = await accessor.store.query<{ reltuples: string | number }>(
    'SELECT reltuples::bigint AS reltuples FROM pg_class c ' +
      'JOIN pg_namespace n ON c.relnamespace = n.oid ' +
      'WHERE n.nspname = $1 AND c.relname = $2',
    [schema, name],
  )
  const value = result.rows[0]?.reltuples
  return value === undefined ? 0 : Number(value)
}

export async function tableSizeBytes(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<number> {
  const result = await accessor.store.query<{ size: string | number }>(
    'SELECT pg_total_relation_size(c.oid) AS size FROM pg_class c ' +
      'JOIN pg_namespace n ON c.relnamespace = n.oid ' +
      'WHERE n.nspname = $1 AND c.relname = $2',
    [schema, name],
  )
  const value = result.rows[0]?.size
  return value === undefined ? 0 : Number(value)
}

/**
 * A relation's rows in key order, as an `ORDER BY` clause. A relation with no
 * primary key (a view, a keyless table) gets none and keeps the order its scan
 * returns. Mirrors Python's `key_order`.
 */
export function keyOrder(pk: readonly string[], descending = false): string {
  if (pk.length === 0) return ''
  const way = descending ? ' DESC' : ''
  return ` ORDER BY ${pk.map((column) => `${quoteIdent(column)}${way}`).join(', ')}`
}

export async function fetchRows(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
  options: { limit: number; offset: number },
): Promise<Record<string, unknown>[]> {
  const pk = await fetchRowKey(accessor, schema, name)
  const result = await accessor.store.query(
    `SELECT * FROM ${qualified(schema, name)}${keyOrder(pk)} LIMIT $1 OFFSET $2`,
    [options.limit, options.offset],
  )
  return result.rows
}

/**
 * Each key column's text, selected under a name no column of the relation
 * has, for a page to start after. node-pg reads a timestamp as a millisecond
 * `Date`, so the driver's value of a key finer than that sorts before the row
 * it came from, and the page after it would answer that row again; the text
 * is the exact key. asyncpg keeps exact values, so Python pages from the row.
 */
function keyTexts(
  pk: readonly string[],
  columns: ReadonlySet<string>,
  source = '',
): [string, string[]] {
  let marker = '__mirage_key'
  while (pk.some((_, i) => columns.has(`${marker}${String(i)}`))) marker += '_'
  const names = pk.map((_, i) => `${marker}${String(i)}`)
  const select = pk.map(
    (column, i) => `, ${source}${quoteIdent(column)}::text AS ${quoteIdent(names[i] ?? '')}`,
  )
  return [select.join(''), names]
}

/**
 * A keyed relation's last `limit` rows, in key order, read off the end of its
 * key with no count, and the exact key of the last one (`keyTexts`). Mirrors
 * Python's `fetch_last_rows`.
 */
export async function fetchLastRows(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
  pk: readonly string[],
  limit: number,
  columns: ReadonlySet<string>,
): Promise<[Record<string, unknown>[], unknown[] | null]> {
  const [select, names] = keyTexts(pk, columns)
  const result = await accessor.store.query(
    `SELECT *${select} FROM (SELECT * FROM ${qualified(schema, name)}${keyOrder(pk, true)} ` +
      `LIMIT $1) last${keyOrder(pk)}`,
    [limit],
  )
  const last = result.rows[result.rows.length - 1]
  return [
    result.rows.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => !names.includes(k))),
    ),
    last === undefined ? null : names.map((column) => last[column]),
  ]
}

/**
 * A keyed relation's rows past a key, in key order, and the exact key of the
 * last one (`keyTexts`); null for the rows when their database JSON passes
 * `maxBytes`, which the database answers before sending any of them
 * (`fetchBoundedQuery`). Mirrors Python's `fetch_rows_after`.
 */
export async function fetchRowsAfter(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
  pk: readonly string[],
  after: readonly unknown[] | null,
  limit: number,
  columns: ReadonlySet<string>,
  maxBytes: number,
): Promise<[Record<string, unknown>[] | null, readonly unknown[] | null]> {
  let where = ''
  const params: unknown[] = [limit]
  if (after !== null) {
    const key = pk.map((column) => quoteIdent(column)).join(', ')
    const marks = pk.map((_, i) => `$${String(i + 2)}`).join(', ')
    where = ` WHERE (${key}) > (${marks})`
    params.push(...after)
  }
  const [select, names] = keyTexts(pk, columns, 'data.')
  const rows = await fetchBoundedQuery(
    accessor,
    `SELECT * FROM ${qualified(schema, name)}${where}${keyOrder(pk)} LIMIT $1`,
    params,
    new Set([...columns, ...names]),
    maxBytes,
    select,
  )
  if (rows === null) return [null, after]
  const last = rows[rows.length - 1]
  return [
    rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => !names.includes(k)))),
    last === undefined ? after : names.map((column) => last[column]),
  ]
}

/**
 * Fetch native rows only when their database JSON fits the byte budget, in key
 * order where the relation has a primary key.
 */
export async function fetchBoundedRows(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
  options: { limit: number; maxBytes: number },
): Promise<Record<string, unknown>[] | null> {
  const columns = new Set((await fetchColumns(accessor, schema, name)).map((column) => column.name))
  const pk = await fetchRowKey(accessor, schema, name)
  return fetchBoundedQuery(
    accessor,
    `SELECT * FROM ${qualified(schema, name)}${keyOrder(pk)} LIMIT $1`,
    [options.limit],
    columns,
    options.maxBytes,
  )
}

/**
 * Budget an internally generated, row-limited SELECT before transferring rows.
 * `extra` adds columns to each answered row past the budget, computed from the
 * row (`data`), so they never count against `maxBytes` (`keyTexts`).
 */
export async function fetchBoundedQuery(
  accessor: PostgresAccessor,
  query: string,
  params: readonly unknown[],
  columns: ReadonlySet<string>,
  maxBytes: number,
  extra = '',
): Promise<Record<string, unknown>[] | null> {
  let marker = '__mirage_bytes'
  while (columns.has(marker)) marker += '_'
  // Keep the gate and fetch in one statement/snapshot. The LEFT JOIN emits
  // only a null row plus the size on overflow, never the oversized values.
  const result = await accessor.store.query(
    `WITH data AS MATERIALIZED (${query}), ` +
      'budget AS (SELECT COALESCE(SUM(' +
      'octet_length(row_to_json(data)::text) + 1), 0) AS bytes FROM data) ' +
      `SELECT data.*${extra}, budget.bytes AS ${quoteIdent(marker)} ` +
      `FROM budget LEFT JOIN data ON budget.bytes <= $${String(params.length + 1)}`,
    [...params, maxBytes],
  )
  const size = Number(result.rows[0]?.[marker])
  if (size > maxBytes) return null
  if (size === 0) return []
  return result.rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== marker)),
  )
}

export async function fetchColumns(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<ColumnInfo[]> {
  const result = await accessor.store.query<{
    column_name: string
    data_type: string
    is_nullable: string
  }>(
    'SELECT column_name, data_type, is_nullable ' +
      'FROM information_schema.columns ' +
      'WHERE table_schema = $1 AND table_name = $2 ' +
      'ORDER BY ordinal_position',
    [schema, name],
  )
  return result.rows.map((r) => ({
    name: r.column_name,
    type: r.data_type,
    nullable: r.is_nullable === 'YES',
  }))
}

export async function fetchPrimaryKey(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<string[]> {
  const result = await accessor.store.query<{ column_name: string }>(
    'SELECT kcu.column_name ' +
      'FROM information_schema.table_constraints tc ' +
      'JOIN information_schema.key_column_usage kcu ' +
      '  ON tc.constraint_name = kcu.constraint_name ' +
      ' AND tc.table_schema = kcu.table_schema ' +
      ' AND tc.table_name = kcu.table_name ' +
      "WHERE tc.constraint_type = 'PRIMARY KEY' " +
      '  AND tc.table_schema = $1 AND tc.table_name = $2 ' +
      'ORDER BY kcu.ordinal_position',
    [schema, name],
  )
  return result.rows.map((r) => r.column_name)
}

/**
 * The columns a relation's rows are listed by: its primary key, when that key
 * is unique over every row a plain read returns. A table with inheritance
 * children reads their rows too, which its key does not cover, so it has none
 * and keeps its scan order; a partitioned table's key covers every partition.
 * Mirrors Python's `fetch_row_key`.
 */
export async function fetchRowKey(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<string[]> {
  const result = await accessor.store.query<{ column_name: string }>(
    'SELECT a.attname AS column_name FROM pg_constraint con ' +
      'JOIN pg_class c ON c.oid = con.conrelid ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY ' +
      'AS k(attnum, ord) ' +
      'JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum ' +
      "WHERE con.contype = 'p' AND n.nspname = $1 AND c.relname = $2 " +
      "AND (c.relkind = 'p' OR NOT c.relhassubclass) " +
      'ORDER BY k.ord',
    [schema, name],
  )
  return result.rows.map((r) => r.column_name)
}

export async function fetchForeignKeys(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<ForeignKey[]> {
  const result = await accessor.store.query<{
    constraint_name: string
    from_column: string
    to_column: string
    ord: number
    to_schema: string
    to_table: string
  }>(
    'SELECT con.conname AS constraint_name, ' +
      '       a.attname AS from_column, ' +
      '       af.attname AS to_column, ' +
      '       k.ord, ' +
      '       nf.nspname AS to_schema, ' +
      '       cf.relname AS to_table ' +
      'FROM pg_constraint con ' +
      'JOIN pg_class c ON c.oid = con.conrelid ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'JOIN pg_class cf ON cf.oid = con.confrelid ' +
      'JOIN pg_namespace nf ON nf.oid = cf.relnamespace ' +
      'JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE ' +
      'JOIN unnest(con.confkey) WITH ORDINALITY AS kf(attnum, ord) ' +
      '  ON kf.ord = k.ord ' +
      'JOIN pg_attribute a ' +
      '  ON a.attrelid = con.conrelid AND a.attnum = k.attnum ' +
      'JOIN pg_attribute af ' +
      '  ON af.attrelid = con.confrelid AND af.attnum = kf.attnum ' +
      "WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 " +
      'ORDER BY con.conname, k.ord',
    [schema, name],
  )
  const grouped = new Map<string, ForeignKey>()
  for (const row of result.rows) {
    let fk = grouped.get(row.constraint_name)
    if (fk === undefined) {
      fk = {
        columns: [],
        references: { schema: row.to_schema, table: row.to_table, columns: [] },
      }
      grouped.set(row.constraint_name, fk)
    }
    fk.columns.push(row.from_column)
    fk.references.columns.push(row.to_column)
  }
  return [...grouped.values()]
}

export async function fetchIndexes(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<IndexInfo[]> {
  const result = await accessor.store.query<{
    name: string
    unique: boolean
    columns: string[]
  }>(
    'SELECT i.relname AS name, ' +
      '       ix.indisunique AS unique, ' +
      '       array_agg(a.attname::text ORDER BY x.ord) AS columns ' +
      'FROM pg_class t ' +
      'JOIN pg_namespace n ON t.relnamespace = n.oid ' +
      'JOIN pg_index ix ON ix.indrelid = t.oid ' +
      'JOIN pg_class i ON i.oid = ix.indexrelid ' +
      'JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ord) ON TRUE ' +
      'JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum ' +
      'WHERE n.nspname = $1 AND t.relname = $2 ' +
      'GROUP BY i.relname, ix.indisunique ' +
      'ORDER BY i.relname',
    [schema, name],
  )
  return result.rows.map((r) => ({
    name: r.name,
    columns: [...r.columns],
    unique: r.unique,
  }))
}

export async function fetchAllRelationships(
  accessor: PostgresAccessor,
  schemas: readonly string[],
): Promise<Relationship[]> {
  if (schemas.length === 0) return []
  const result = await accessor.store.query<{
    constraint_name: string
    from_schema: string
    from_table: string
    from_column: string
    to_column: string
    ord: number
    to_schema: string
    to_table: string
  }>(
    'SELECT con.conname AS constraint_name, ' +
      '       n.nspname AS from_schema, ' +
      '       c.relname AS from_table, ' +
      '       a.attname AS from_column, ' +
      '       af.attname AS to_column, ' +
      '       k.ord, ' +
      '       nf.nspname AS to_schema, ' +
      '       cf.relname AS to_table ' +
      'FROM pg_constraint con ' +
      'JOIN pg_class c ON c.oid = con.conrelid ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'JOIN pg_class cf ON cf.oid = con.confrelid ' +
      'JOIN pg_namespace nf ON nf.oid = cf.relnamespace ' +
      'JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON TRUE ' +
      'JOIN unnest(con.confkey) WITH ORDINALITY AS kf(attnum, ord) ' +
      '  ON kf.ord = k.ord ' +
      'JOIN pg_attribute a ' +
      '  ON a.attrelid = con.conrelid AND a.attnum = k.attnum ' +
      'JOIN pg_attribute af ' +
      '  ON af.attrelid = con.confrelid AND af.attnum = kf.attnum ' +
      "WHERE con.contype = 'f' AND n.nspname = ANY($1::text[]) " +
      'ORDER BY n.nspname, c.relname, con.conname, k.ord',
    [schemas],
  )
  const grouped = new Map<string, Relationship>()
  for (const row of result.rows) {
    const key = `${row.from_schema}\0${row.from_table}\0${row.constraint_name}`
    let rel = grouped.get(key)
    if (rel === undefined) {
      rel = {
        from: { schema: row.from_schema, table: row.from_table, columns: [] },
        to: { schema: row.to_schema, table: row.to_table, columns: [] },
        kind: 'many_to_one',
      }
      grouped.set(key, rel)
    }
    rel.from.columns.push(row.from_column)
    rel.to.columns.push(row.to_column)
  }
  return [...grouped.values()]
}

export async function fetchTableComment(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<string | null> {
  const result = await accessor.store.query<{ obj_description: string | null }>(
    "SELECT obj_description(c.oid, 'pg_class') " +
      'FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'WHERE n.nspname = $1 AND c.relname = $2',
    [schema, name],
  )
  return result.rows[0]?.obj_description ?? null
}

export async function fetchColumnComments(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<Map<string, string>> {
  const result = await accessor.store.query<{ attname: string; comment: string | null }>(
    'SELECT a.attname, col_description(c.oid, a.attnum) AS comment ' +
      'FROM pg_class c ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'JOIN pg_attribute a ' +
      '  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ' +
      'WHERE n.nspname = $1 AND c.relname = $2 ' +
      'ORDER BY a.attnum',
    [schema, name],
  )
  const out = new Map<string, string>()
  for (const r of result.rows) {
    if (r.comment) out.set(r.attname, r.comment)
  }
  return out
}

export async function fetchEnumColumns(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<Map<string, EnumInfo>> {
  const result = await accessor.store.query<{
    attname: string
    typname: string
    labels: string[]
  }>(
    'SELECT a.attname, t.typname, ' +
      '       array_agg(e.enumlabel ORDER BY e.enumsortorder)::text[] AS labels ' +
      'FROM pg_class c ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      'JOIN pg_attribute a ' +
      '  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ' +
      'JOIN pg_type t ON t.oid = a.atttypid ' +
      'JOIN pg_enum e ON e.enumtypid = t.oid ' +
      'WHERE n.nspname = $1 AND c.relname = $2 ' +
      'GROUP BY a.attname, t.typname',
    [schema, name],
  )
  const out = new Map<string, EnumInfo>()
  for (const r of result.rows) {
    out.set(r.attname, { type: r.typname, labels: [...r.labels] })
  }
  return out
}

export async function fetchColumnStats(
  accessor: PostgresAccessor,
  schema: string,
  name: string,
): Promise<Map<string, ColumnStats>> {
  // pg_stats is populated by ANALYZE, so it is empty for a freshly written
  // relation until autovacuum gets to it. Callers treat it as best-effort;
  // mirage never runs ANALYZE itself (a write and a cost on the user's DB).
  const result = await accessor.store.query<{
    attname: string
    n_distinct: number | string
    mcv: string[] | null
  }>(
    'SELECT attname, n_distinct, ' +
      '       most_common_vals::text::text[] AS mcv ' +
      'FROM pg_stats WHERE schemaname = $1 AND tablename = $2',
    [schema, name],
  )
  const out = new Map<string, ColumnStats>()
  for (const r of result.rows) {
    out.set(r.attname, {
      n_distinct: Number(r.n_distinct),
      most_common_vals: r.mcv ? [...r.mcv] : [],
    })
  }
  return out
}
