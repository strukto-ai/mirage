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
import type { PathSpec } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'
import { fetchBoundedQuery, fetchColumns, qualified, quoteIdent } from './client.ts'
import { rowLine } from './read.ts'
import { detectScope } from './scope.ts'

// Column types whose `::text` is the value exactly as a rows.jsonl line spells
// it, so a LIKE over the cast finds every row whose line holds the text inside
// that value. Everything else renders differently in the line (a timestamp's
// separator, a float's digits, a `char(n)`'s padding, json's spacing), and a
// table holding one is not searchable. Mirrors `_SAME_TEXT_TYPES` in
// `mirage/core/postgres/search.py`.
const SAME_TEXT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'character varying',
  'name',
  'uuid',
  'smallint',
  'integer',
  'bigint',
  'boolean',
])
// The ones that can hold a control character, which the line spells as an
// escape (`\n`, `\u0001`), so the text can match the escape's letters in a
// row whose value never holds them: such rows are candidates too.
const STRING_TYPES: ReadonlySet<string> = new Set(['text', 'character varying', 'name'])
// What a line spells around and between values: a text holding one can match
// where no single value holds it (`:4` after a key).
const STRUCTURAL: ReadonlySet<string> = new Set(['"', '\\', ':', ',', '{', '}'])
// How a NULL spells in the line; no LIKE over a NULL ever matches it.
const NULL = 'null'

// Escape LIKE/ILIKE wildcards so the text matches as a literal: Postgres LIKE
// treats % and _ as wildcards and \ as the default escape char, but grep's
// text has no such meaning (`user_id` must not match `userXid`).
function escapeLike(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// Whether a LIKE over the columns finds every line a scan would. A LIKE per
// column sees only values: a text that can match a key (every row holds every
// key), the text between values, a NULL's `null` or a value the line spells
// differently from its cast would be found by the scan and missed by the
// query. Mirrors `_answerable` in `mirage/core/postgres/search.py`.
function answerable(
  columns: readonly [string, string][],
  text: string,
  ignoreCase: boolean,
): boolean {
  for (const ch of text) {
    if (STRUCTURAL.has(ch) || (ch.codePointAt(0) ?? 0) < 0x20) return false
  }
  const folded = ignoreCase ? text.toLowerCase() : text
  if (NULL.includes(folded)) return false
  for (const [name, dataType] of columns) {
    if (!SAME_TEXT_TYPES.has(dataType)) return false
    if ((ignoreCase ? name.toLowerCase() : name).includes(folded)) return false
  }
  return true
}

/**
 * The lines of a table's or view's rows.jsonl that may hold `text`. A LIKE
 * (ILIKE under -i) over every column picks the rows whose value holds `text`,
 * plus any row with a control character the line spells as an escape; grep
 * matches each line itself. The rows come in the order the plain read returns
 * them, a scan of the same relation. Null for any other file, when the columns
 * or the text keep a LIKE from seeing every match (`answerable`), or past
 * `maxReadRows` rows or `maxReadBytes` bytes, where reading the file refuses
 * it as too large. Mirrors `lines_containing` in
 * `mirage/core/postgres/search.py`.
 */
export async function linesContaining(
  accessor: PostgresAccessor,
  path: PathSpec,
  text: string,
  ignoreCase: boolean,
): Promise<Uint8Array | null> {
  const match = detectScope(path)
  if (match.kind !== 'entity_rows') return null
  const schema = match.slots.schema ?? ''
  const entity = match.slots.entity ?? ''
  const { maxReadRows, maxReadBytes } = accessor.config
  const columns = (await fetchColumns(accessor, schema, entity)).map((c): [string, string] => [
    c.name,
    c.type,
  ])
  if (columns.length === 0 || !answerable(columns, text, ignoreCase)) return null
  const op = ignoreCase ? 'ILIKE' : 'LIKE'
  const clauses = columns.map(([name]) => `${quoteIdent(name)}::text ${op} $1`)
  for (const [name, dataType] of columns) {
    if (STRING_TYPES.has(dataType)) clauses.push(`${quoteIdent(name)} ~ '[[:cntrl:]]'`)
  }
  const sql = `SELECT * FROM ${qualified(schema, entity)} WHERE ${clauses.join(' OR ')} LIMIT $2`
  const rows = await fetchBoundedQuery(
    accessor,
    sql,
    [`%${escapeLike(text)}%`, maxReadRows + 1],
    new Set(columns.map(([name]) => name)),
    maxReadBytes,
  )
  if (rows === null || rows.length > maxReadRows) return null
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let size = 0
  for (const row of rows) {
    const line = encoder.encode(rowLine(row) + '\n')
    size += line.length
    if (size > maxReadBytes) return null
    chunks.push(line)
  }
  return concat(chunks)
}
