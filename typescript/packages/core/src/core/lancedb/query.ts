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

import type { LanceRow } from './types.ts'

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

export function eqClause(column: string, value: string): string {
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

export async function tableExists(accessor: LanceDBAccessor, name: string): Promise<boolean> {
  return (await accessor.driver.listTables()).includes(name)
}

export async function searchRows(
  accessor: LanceDBAccessor,
  table: string,
  query: string,
  limit: number,
): Promise<LanceRow[]> {
  const key = JSON.stringify([table, query, limit])
  const hit = accessor.searchCache.get(key)
  if (hit !== undefined) return hit
  const rows = await accessor.driver.search(table, query, limit)
  accessor.searchCache.set(key, rows)
  return rows
}
