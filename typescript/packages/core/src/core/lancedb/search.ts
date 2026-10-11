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
import type { PathSpec } from '../../types.ts'
import { mountedPath } from '../../utils/key_prefix.ts'
import { recordQueries } from '../../utils/record_search.ts'
import type { LanceDBConfigResolved } from '../../vfs/lancedb/config.ts'
import { PATH_SAFE } from '../hierarchy/codec.ts'
import { filtersOf, tableOf } from '../vector/scope.ts'
import type { Row } from '../vector/types.ts'
import { holdingClause, rowsWhere, textColumns } from './query.ts'
import { cellText, renderCard } from './render.ts'
import { detectFor } from './scope.ts'

// What a card spells outside its string values: a boolean, a null, a float no
// JSON number holds, and the blob line's name.
export const CARD_WORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  'nan',
  'inf',
  'infinity',
  'blob',
])

/**
 * A row's card path below its table: its group values as the listing names
 * them, then `<id>.md`. Mirrors Python's `card_path`.
 */
export function cardPath(config: LanceDBConfigResolved, row: Row): string[] {
  const segments: string[] = []
  for (const column of config.groupBy) {
    const value = row[column]
    if (value !== null && value !== undefined) segments.push(PATH_SAFE.encode(cellText(value)))
  }
  return [...segments, `${cellText(row[config.idColumn])}.md`]
}

/** A ranked row's path below its table, and its card. */
export function hit(accessor: LanceDBAccessor, row: Row): [string[], Uint8Array] {
  return [cardPath(accessor.config, row), renderCard(row, accessor.config)]
}

/**
 * The cards under `under` whose row holds `text` in a string column.
 *
 * A card is `column: value` lines, so a line grep matches holds the text in
 * one value, unless it reaches into the column's name, the title's `# ` or the
 * separator: the text is asked only when `recordQueries` passes it with every
 * rendered column's name and `CARD_WORDS` as keys, it does not start with a
 * space, and no column's name or the blob line's extension holds it. A value that is not a string spells only digits and signs, or one of
 * `CARD_WORDS`; a table that renders a list, struct or bytes column reads every
 * card, as does a scope inside a card. Mirrors Python's `files_containing`.
 */
export async function filesContaining(
  accessor: LanceDBAccessor,
  text: string,
  under: readonly PathSpec[],
  wholeWord: boolean,
  ignoreCase: boolean,
): Promise<PathSpec[] | null> {
  if (text.startsWith(' ')) return null
  const config = accessor.config
  const skipped = new Set([config.vectorColumn, config.blobColumn].filter((c) => c !== null))
  const found: PathSpec[] = []
  for (const scope of under) {
    const match = detectFor(accessor)(scope.mountPath)
    let tables: string[]
    if (match.kind === 'root') {
      tables = config.table !== null ? [config.table] : await accessor.driver.listTables()
    } else if (match.kind === 'group') {
      tables = [tableOf(config.table ?? null, match)]
    } else {
      return null
    }
    const filters = filtersOf(config.groupBy, match)
    for (const table of tables) {
      const columns = await textColumns(accessor, table, skipped)
      if (columns === null) return null
      const rendered = (await accessor.driver.tableColumns(table)).filter((c) => !skipped.has(c))
      const labels = rendered.map((c) => c.toLowerCase())
      if (config.blobColumn !== null) labels.push(config.blobExt.toLowerCase())
      if (labels.some((label) => label.includes(text.toLowerCase()))) return null
      const queries = recordQueries(text, new Set([...labels, ...CARD_WORDS]), wholeWord)
      if (queries === null) return null
      if (columns.length === 0) continue
      const rows = await rowsWhere(
        accessor,
        table,
        holdingClause(columns, queries, ignoreCase, filters),
        [config.idColumn, ...config.groupBy],
      )
      const base = config.table !== null ? '' : `/${table}`
      for (const row of rows) {
        const id = row[config.idColumn]
        if (id === null || id === undefined) continue
        if (config.groupBy.some((g) => row[g] === null || row[g] === undefined)) continue
        found.push(mountedPath(scope, `${base}/${cardPath(config, row).join('/')}`))
      }
    }
  }
  return found
}
