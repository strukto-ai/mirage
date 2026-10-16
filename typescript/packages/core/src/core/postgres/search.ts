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

import { TEXT_TYPES, type PostgresAccessor } from '../../accessor/postgres.ts'
import type { PathSpec } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'
import { fetchBoundedQuery, fetchRowKey, keyOrder, qualified, quoteIdent } from './client.ts'
import { rowLine } from './read.ts'
import { detectScope } from './scope.ts'

// Types whose `::text` is the value exactly as a rows.jsonl line spells it,
// so a LIKE over the cast finds every row whose line holds the text inside
// that value. A date or time type's row keeps that text. Mirrors
// `_SAME_TEXT_TYPES` in `mirage/core/postgres/search.py`.
const SAME_TEXT_TYPES: ReadonlySet<string> = new Set([
  'uuid',
  'int2',
  'int4',
  'int8',
  'bool',
  ...Object.keys(TEXT_TYPES),
])
// The strings among them, which can hold a control character the line spells
// as an escape (`\n`, `\u0001`), so the text can match the escape's letters in
// a row whose value never holds them: such rows are candidates too. An enum's
// label is one as well.
const STRING_TYPES: ReadonlySet<string> = new Set(['text', 'varchar', 'name'])
// Array elements whose `::text` is each element as the line spells it.
const SAME_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  ...STRING_TYPES,
  'uuid',
  'int2',
  'int4',
  'int8',
  ...Object.keys(TEXT_TYPES),
])
// Every character a value of these types spells in a line on either host (a
// float's exponent, a numeric's NaN or Infinity), folded to lowercase. A text
// holding any other character is never inside such a value, so the column is
// left out of the search.
const NUMBER = '0123456789.+-e'
const SPELLED_WITH: Readonly<Record<string, string>> = {
  float4: NUMBER,
  float8: NUMBER,
  numeric: `${NUMBER}nainfty`,
}
// A value of each date and time type and of an array of each, which a driver
// that reads them as Postgres text (`readAsText`) answers as text. Only then
// does a LIKE over their cast see what the line spells: a browser mount takes
// any driver, and one that parses them (into a `Date`) leaves them to the scan.
const TEXT_PROBE =
  "SELECT 'epoch'::date AS d, 'epoch'::timestamp AS ts, 'epoch'::timestamptz AS tz, " +
  "'allballs'::time AS t, 'allballs'::timetz AS ttz, '0'::interval AS i, " +
  "'{epoch}'::date[] AS da, '{epoch}'::timestamp[] AS tsa, " +
  "'{epoch}'::timestamptz[] AS tza, '{allballs}'::time[] AS ta, " +
  "'{allballs}'::timetz[] AS ttza, '{0}'::interval[] AS ia"
// What a line spells around and between values: a text holding one can match
// where no single value holds it (`:4` after a key).
const STRUCTURAL: ReadonlySet<string> = new Set(['"', '\\', ':', ',', '{', '}'])
// How a NULL spells in the line; no LIKE over a NULL ever matches it.
const NULL = 'null'
// Relations whose rows a plain read takes in ctid order: a table or a
// materialized view with no child. Any other (a view, a parent appending its
// children's rows) is numbered in the order a plain read returns it.
const HEAP_KINDS: ReadonlySet<string> = new Set(['r', 'm'])
const RELATION =
  'SELECT c.relkind::text AS relkind, c.relhassubclass FROM pg_class c ' +
  'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
  'WHERE n.nspname = $1 AND c.relname = $2'
// Each column's type, a domain's base type in its place, with its category
// (E an enum, A an array) and an array's element type.
const COLUMNS =
  'SELECT a.attname AS name, COALESCE(b.typname, t.typname) AS type, ' +
  'COALESCE(b.typcategory, t.typcategory)::text AS category, ' +
  'e.typname AS element FROM pg_attribute a ' +
  'JOIN pg_class c ON c.oid = a.attrelid ' +
  'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
  'JOIN pg_type t ON t.oid = a.atttypid ' +
  'LEFT JOIN pg_type b ON b.oid = t.typbasetype ' +
  'LEFT JOIN pg_type e ON e.oid = COALESCE(b.typelem, t.typelem) ' +
  'WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 ' +
  'AND NOT a.attisdropped ORDER BY a.attnum'

interface Column {
  name: string
  type: string
  category: string
  element: string | null
}

type How = 'like' | 'string' | 'skip'

// Escape LIKE/ILIKE wildcards so the text matches as a literal: Postgres LIKE
// treats % and _ as wildcards and \ as the default escape char, but grep's
// text has no such meaning (`user_id` must not match `userXid`).
function escapeLike(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * How a LIKE covers one column: `like` over its cast, `string` over its cast
 * plus its rows holding a control character, `skip` when no value of it can
 * spell `text`, null when none of these sees every match. A `char(n)` pads its
 * value and its cast strips the padding, so only a text without a space is
 * covered. A jsonb value lines up with its cast except for a number the line
 * may spell another way (a large one in exponent form), so a text that could
 * lie inside a number, or that holds a bracket next to one, is not. An
 * array's line brackets where its cast braces. Mirrors `_column_search` in
 * `mirage/core/postgres/search.py`.
 */
function columnSearch(column: Column, text: string): How | null {
  const folded = [...new Set(text.toLowerCase())]
  const bracketed = text.includes('[') || text.includes(']')
  if (STRING_TYPES.has(column.type) || column.category === 'E') return 'string'
  if (SAME_TEXT_TYPES.has(column.type)) return 'like'
  if (column.type === 'bpchar') return text.includes(' ') ? null : 'string'
  if (column.type === 'jsonb') {
    return bracketed || folded.every((ch) => NUMBER.includes(ch)) ? null : 'like'
  }
  if (column.category === 'A') {
    if (column.element === null || !SAME_TEXT_ELEMENTS.has(column.element) || bracketed) {
      return null
    }
    return STRING_TYPES.has(column.element) ? 'string' : 'like'
  }
  const spelled = SPELLED_WITH[column.type]
  if (spelled !== undefined && !folded.every((ch) => spelled.includes(ch))) return 'skip'
  return null
}

/**
 * Each searched column and how, or null when a LIKE over the columns cannot
 * find every line a scan would. A LIKE per column sees only values: a text
 * that can match a key (every row holds every key), the text between values,
 * a NULL's `null` or a value the line spells differently from its cast would
 * be found by the scan and missed by the query. Mirrors `_searches` in
 * `mirage/core/postgres/search.py`.
 */
function searches(
  columns: readonly Column[],
  text: string,
  ignoreCase: boolean,
): [string, How][] | null {
  for (const ch of text) {
    if (STRUCTURAL.has(ch) || (ch.codePointAt(0) ?? 0) < 0x20) return null
  }
  const folded = ignoreCase ? text.toLowerCase() : text
  if (NULL.includes(folded)) return null
  const searched: [string, How][] = []
  for (const column of columns) {
    if ((ignoreCase ? column.name.toLowerCase() : column.name).includes(folded)) return null
    const how = columnSearch(column, text)
    if (how === null) return null
    if (how !== 'skip') searched.push([column.name, how])
  }
  return searched
}

/**
 * The lines of a relation's rows.jsonl that may hold `text`. A LIKE (ILIKE
 * under -i) over every column that can spell `text` picks the rows whose value
 * holds it, plus any row with a control character the line spells as an
 * escape; grep matches each line itself. The rows come in the plain read's
 * order: a keyed relation's in key order; a keyless table's in ctid order, the
 * order the plain read scans the heap in, whatever plan the filter gets (an
 * index or a parallel scan returns them otherwise); any other relation's
 * numbered as a plain read returns them before the filter. Null for any other
 * file, when the columns or the text keep a LIKE from seeing every match
 * (`searches`), when a date or time column is searched and the driver does not
 * read those types as text (`TEXT_PROBE`), or past `maxReadRows` rows or
 * `maxReadBytes` bytes, where reading the file refuses it as too large.
 * Mirrors `lines_containing` in `mirage/core/postgres/search.py`.
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
  const relation = (
    await accessor.store.query<{ relkind: string; relhassubclass: boolean }>(RELATION, [
      schema,
      entity,
    ])
  ).rows
  const [only] = relation
  if (relation.length !== 1 || only === undefined) return null
  const columns = (await accessor.store.query<Column>(COLUMNS, [schema, entity])).rows
  if (columns.length === 0) return null
  const searched = searches(columns, text, ignoreCase)
  if (searched === null) return null
  if (searched.length === 0) return new Uint8Array(0)
  if (
    columns.some(
      (c) =>
        Object.hasOwn(TEXT_TYPES, c.type) ||
        (c.category === 'A' && c.element !== null && Object.hasOwn(TEXT_TYPES, c.element)),
    ) &&
    !Object.values((await accessor.store.query(TEXT_PROBE)).rows[0] ?? {}).every(
      (value) =>
        typeof value === 'string' ||
        (Array.isArray(value) && value.every((element) => typeof element === 'string')),
    )
  ) {
    return null
  }
  const op = ignoreCase ? 'ILIKE' : 'LIKE'
  const clauses: string[] = []
  for (const [name, how] of searched) {
    clauses.push(`${quoteIdent(name)}::text ${op} $1`)
    if (how === 'string') clauses.push(`${quoteIdent(name)}::text ~ '[[:cntrl:]]'`)
  }
  const names = new Set(columns.map((c) => c.name))
  const source = qualified(schema, entity)
  const where = clauses.join(' OR ')
  let marker = '__mirage_row'
  while (names.has(marker)) marker += '_'
  const numbered = quoteIdent(marker)
  const pk = await fetchRowKey(accessor, schema, entity)
  const sql =
    pk.length > 0
      ? `SELECT * FROM ${source} WHERE ${where}${keyOrder(pk)} LIMIT $2`
      : HEAP_KINDS.has(only.relkind) && !only.relhassubclass
        ? `SELECT * FROM ${source} WHERE ${where} ORDER BY ctid LIMIT $2`
        : `SELECT * FROM (SELECT row_number() OVER () AS ${numbered}, r.* FROM ${source} r) s ` +
          `WHERE ${where} ORDER BY ${numbered} LIMIT $2`
  const rows = await fetchBoundedQuery(
    accessor,
    sql,
    [`%${escapeLike(text)}%`, maxReadRows + 1],
    new Set([...names, marker]),
    maxReadBytes,
  )
  if (rows === null || rows.length > maxReadRows) return null
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  let size = 0
  for (const row of rows) {
    const line = encoder.encode(
      rowLine(Object.fromEntries(Object.entries(row).filter(([key]) => key !== marker))) + '\n',
    )
    size += line.length
    if (size > maxReadBytes) return null
    chunks.push(line)
  }
  return concat(chunks)
}
