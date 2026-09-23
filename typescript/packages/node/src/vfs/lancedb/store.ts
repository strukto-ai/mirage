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

import type { Connection, Query, Table } from '@lancedb/lancedb'
import type { LanceDriver, LanceRow, ValueTest } from '@struktoai/mirage-core/core/lancedb/_driver'
import type { LanceDBConfigResolved } from '@struktoai/mirage-core/vfs/lancedb/config'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'

function toStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value as string | number | boolean | bigint)
}

function textsOf(rows: LanceRow[], column: string): string[] {
  const texts: string[] = []
  for (const row of rows) {
    const value = row[column]
    if (value !== null && value !== undefined) texts.push(toStr(value))
  }
  return texts
}

/**
 * The first `limit` values of `column` that pass `keep`.
 *
 * Streams the unbounded query batch by batch and stops at the cap, so a scan
 * past the head of the table costs one batch of memory.
 */
async function keptTexts(
  query: Query,
  column: string,
  limit: number,
  keep: ValueTest,
): Promise<string[]> {
  const texts: string[] = []
  for await (const batch of query) {
    for (const row of batch.toArray() as LanceRow[]) {
      const value = row[column]
      if (value === null || value === undefined) continue
      const text = toStr(value)
      if (keep(text)) {
        texts.push(text)
        if (texts.length >= limit) return texts
      }
    }
  }
  return texts
}

/**
 * A configured column name, spelled so the parser reads a column.
 *
 * Backticks, not double quotes: lance reads a double-quoted word as a string
 * literal, so `"id" = 'x'` compares the text `id` and matches nothing rather
 * than failing. Quoting is what lets a name with a space or a reserved word
 * through, and a bare name means the same thing quoted.
 */
function columnRef(name: string): string {
  return `\`${name.split('`').join('``')}\``
}

function eqClause(column: string, value: string): string {
  if (/^-?\d+$/.test(value)) return `${columnRef(column)} = ${value}`
  return `${columnRef(column)} = '${value.replace(/'/g, "''")}'`
}

function whereClause(filters: Record<string, string>): string {
  return Object.entries(filters)
    .map(([col, val]) => eqClause(col, val))
    .join(' AND ')
}

function likeClause(column: string, prefix: string): string {
  let escaped = prefix
  for (const ch of ['\\', '%', '_']) escaped = escaped.split(ch).join(`\\${ch}`)
  return `CAST(${columnRef(column)} AS STRING) LIKE '${escaped.replace(/'/g, "''")}%' ESCAPE '\\'`
}

/**
 * The where clause for a group's filters plus a name prefix.
 *
 * The prefix is what a glob narrows the query to: the cap on rows is a window
 * over the table, so filtering the head of it would hide every match past the
 * cap, while a prefix match moves the window onto what the line asked for.
 * LIKE has its own metacharacters, so `%` and `_` in the prefix are escaped
 * rather than left to widen the match, and the cast is what lets a numeric id
 * column take one.
 */
export function predicate(column: string, filters: Record<string, string>, prefix: string): string {
  const parts: string[] = []
  if (Object.keys(filters).length > 0) parts.push(whereClause(filters))
  if (prefix !== '' && column !== '') parts.push(likeClause(column, prefix))
  return parts.join(' AND ')
}

export class LanceDBStore implements LanceDriver {
  private readonly config: LanceDBConfigResolved
  private db: Connection | null = null
  private readonly tables = new Map<string, Table>()

  constructor(config: LanceDBConfigResolved) {
    this.config = config
  }

  private async connection(): Promise<Connection> {
    if (this.db === null) {
      const options: Record<string, unknown> = {}
      if (this.config.apiKey !== null) options.apiKey = this.config.apiKey
      if (this.config.storageOptions !== null) options.storageOptions = this.config.storageOptions
      if (this.config.uri.startsWith('db://')) {
        options.region = this.config.region
        if (this.config.hostOverride !== null) options.hostOverride = this.config.hostOverride
      }
      const { connect } = await loadOptionalPeer(() => import('@lancedb/lancedb'), {
        feature: 'LanceDBVFS',
        packageName: '@lancedb/lancedb',
      })
      this.db = await connect(this.config.uri, options)
    }
    return this.db
  }

  private async table(name: string): Promise<Table> {
    const cached = this.tables.get(name)
    if (cached !== undefined) return cached
    const db = await this.connection()
    const tbl = await db.openTable(name)
    this.tables.set(name, tbl)
    return tbl
  }

  async listTables(): Promise<string[]> {
    const db = await this.connection()
    const names = await db.tableNames()
    return [...names].sort(compareCodePoints)
  }

  async distinct(
    table: string,
    column: string,
    filters: Record<string, string>,
    limit: number,
    prefix = '',
    keep?: ValueTest,
  ): Promise<string[]> {
    const tbl = await this.table(table)
    let query = tbl.query().select([column])
    const clause = predicate(column, filters, prefix)
    if (clause !== '') query = query.where(clause)
    const texts =
      keep === undefined
        ? textsOf((await query.limit(limit).toArray()) as LanceRow[], column)
        : await keptTexts(query, column, limit, keep)
    return [...new Set(texts)].sort(compareCodePoints)
  }

  async tableColumns(table: string): Promise<string[]> {
    const tbl = await this.table(table)
    const schema = await tbl.schema()
    return schema.fields.map((field) => field.name)
  }

  async rowsMatching(
    table: string,
    filters: Record<string, string>,
    columns: string[],
    limit: number,
    idColumn = '',
    prefix = '',
  ): Promise<LanceRow[]> {
    const tbl = await this.table(table)
    let query = tbl.query().select(columns).limit(limit)
    const clause = predicate(idColumn, filters, prefix)
    if (clause !== '') query = query.where(clause)
    return (await query.toArray()) as LanceRow[]
  }

  async rowRecord(table: string, idColumn: string, rowId: string): Promise<LanceRow | null> {
    const tbl = await this.table(table)
    const rows = (await tbl
      .query()
      .where(eqClause(idColumn, rowId))
      .limit(1)
      .toArray()) as LanceRow[]
    return rows[0] ?? null
  }

  async search(table: string, query: string, limit: number): Promise<LanceRow[]> {
    const tbl = await this.table(table)
    return (await tbl.search(query).limit(limit).toArray()) as LanceRow[]
  }

  close(): Promise<void> {
    if (this.db !== null) {
      this.db.close()
      this.db = null
    }
    this.tables.clear()
    return Promise.resolve()
  }
}
