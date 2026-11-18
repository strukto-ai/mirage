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

import { compareCodePoints } from '../../utils/sort.ts'
import { PaginationStalledError } from '../api/errors.ts'
import type { LanceDBAccessor } from '../../accessor/lancedb.ts'

import { openStreamSync } from '../../rs/stream.ts'

import type { LanceRow } from './types.ts'

const DECODER = new TextDecoder()

/** Render an equality with Rust's shared Lance SQL quoting. */
export function eqClause(column: string, value: string): string {
  const stream = openStreamSync('lance_query', { op: 'equal', column, value })
  try {
    return DECODER.decode(stream.finish())
  } finally {
    stream.close()
  }
}

/** Render group filters and a literal name prefix in Lance SQL. */
export function predicate(column: string, filters: Record<string, string>, prefix: string): string {
  const stream = openStreamSync('lance_query', {
    op: 'predicate',
    column,
    filters: Object.entries(filters),
    prefix,
  })
  try {
    return DECODER.decode(stream.finish())
  } finally {
    stream.close()
  }
}

/** Render the filter for string columns holding one of the ASCII text needles. */
export function holdingClause(
  columns: readonly string[],
  texts: readonly string[],
  ignoreCase: boolean,
  filters: Record<string, string>,
): string {
  const stream = openStreamSync('lance_query', {
    op: 'holding',
    columns: [...columns],
    texts: [...texts],
    ignore_case: ignoreCase,
    filters: Object.entries(filters),
  })
  try {
    return DECODER.decode(stream.finish())
  } finally {
    stream.close()
  }
}

/**
 * The string columns of a table's card, or null when a column the card
 * renders is neither a string nor a scalar. Mirrors Python's `text_columns`.
 */
export function textColumns(
  accessor: LanceDBAccessor,
  table: string,
  skipped: ReadonlySet<string>,
): Promise<string[] | null> {
  return accessor.driver.textColumns(table, skipped)
}

/**
 * Every row the clause keeps, `columns` selected, or null when more than
 * `limit` do. Mirrors Python's `rows_where`.
 */
export async function rowsWhere(
  accessor: LanceDBAccessor,
  table: string,
  clause: string,
  columns: string[],
  limit: number,
): Promise<LanceRow[] | null> {
  const rows = await accessor.driver.rowsWhere(table, clause, columns, limit + 1)
  return rows.length <= limit ? rows : null
}

/** Read each SDK page, resuming after the last table name it returned. */
export async function listTables(
  tableNames: (options: { limit: number; startAfter?: string }) => Promise<string[]>,
): Promise<string[]> {
  const limit = 100
  const names: string[] = []
  let startAfter: string | undefined
  for (;;) {
    const page = await tableNames(startAfter === undefined ? { limit } : { limit, startAfter })
    for (const name of page) names.push(name)
    if (page.length < limit) return names.sort(compareCodePoints)
    const last = page.at(-1)
    if (
      last === undefined ||
      (startAfter !== undefined && compareCodePoints(last, startAfter) <= 0)
    ) {
      throw new PaginationStalledError(last ?? '')
    }
    startAfter = last
  }
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
  return accessor.searches.get(JSON.stringify([table, query, limit]), () =>
    accessor.driver.search(table, query, limit),
  )
}
