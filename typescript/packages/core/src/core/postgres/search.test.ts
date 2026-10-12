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

import { describe, expect, it } from 'vitest'

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { PathSpec } from '../../types.ts'
import { resolvePostgresConfig } from '../../vfs/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import { linesContaining } from './search.ts'

type Row = Record<string, unknown>

const ROWS = '/public/tables/users/rows.jsonl'

function columns(...specs: string[][]): Row[] {
  // What `COLUMNS` reads off the catalog: name, type, category and an array's
  // element type.
  return specs.map(([name, type, category, element]) => ({
    name,
    type,
    category: category ?? 'X',
    element: element ?? null,
  }))
}

const USERS = columns(['id', 'int4'], ['name', 'text'])

function path(p: string = ROWS): PathSpec {
  return new PathSpec({ virtual: p, directory: p, vfsPath: p.replace(/^\/+/, '') })
}

const TABLE: Row[] = [{ relkind: 'r', relhassubclass: false }]

// A driver that answers the relation, then its columns, then the bounded row
// query, recording the SQL and parameters it was asked.
function makeAccessor(
  cols: Row[],
  rows: Row[],
  config: { maxReadRows?: number; maxReadBytes?: number } = {},
  databaseBytes = 100,
  relation: Row[] = TABLE,
): { accessor: PostgresAccessor; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = []
  const driver: PgDriver = {
    query: ((sql: string, params: unknown[] = []) => {
      calls.push([sql, params])
      if (sql.includes('relhassubclass')) {
        return Promise.resolve({ rows: relation, rowCount: relation.length })
      }
      if (sql.includes('pg_attribute')) {
        return Promise.resolve({ rows: cols, rowCount: cols.length })
      }
      return Promise.resolve({
        rows:
          rows.length === 0
            ? [{ __mirage_bytes: 0 }]
            : rows.map((row) => ({ ...row, __mirage_bytes: databaseBytes })),
        rowCount: rows.length,
      })
    }) as PgDriver['query'],
    close: () => Promise.resolve(),
  }
  const cfg = resolvePostgresConfig({ dsn: 'postgres://localhost/db', ...config })
  return { accessor: new PostgresAccessor(driver, cfg), calls }
}

async function lines(
  accessor: PostgresAccessor,
  text: string,
  ignoreCase = false,
): Promise<string | null> {
  const found = await linesContaining(accessor, path(), text, ignoreCase)
  return found === null ? null : new TextDecoder().decode(found)
}

// Twin of tests/core/postgres/test_search.py.
describe('linesContaining', () => {
  it('answers the rows holding the text as the file spells them', async () => {
    const { accessor } = makeAccessor(USERS, [
      { id: 1, name: 'alice' },
      { id: 2, name: 'alex' },
    ])
    expect(await lines(accessor, 'al')).toBe('{"id":1,"name":"alice"}\n{"id":2,"name":"alex"}\n')
  })

  it.each(['\u0085', ' ', ' '])('keeps Unicode separator %j inside a line', async (separator) => {
    const { accessor } = makeAccessor(USERS, [{ id: 1, name: `left${separator}right` }])
    expect(await lines(accessor, 'left')).toBe(`{"id":1,"name":"left${separator}right"}\n`)
  })

  it('casts every column and takes escaped rows', async () => {
    const { accessor, calls } = makeAccessor(USERS, [])
    expect(await lines(accessor, 'user_id')).toBe('')
    const [sql, params] = calls[2] ?? ['', []]
    // grep is case-sensitive by default, so the query uses LIKE; an integer
    // column is searched through its cast, which spells it the way the line
    // does; a string column holding a control character is a candidate,
    // since the line spells it as an escape.
    expect(sql).not.toContain('ILIKE')
    expect(sql).toContain('"id"::text LIKE $1')
    expect(sql).toContain('"name"::text LIKE $1')
    expect(sql).toContain(`"name"::text ~ '[[:cntrl:]]'`)
    expect(sql).not.toContain('"id"::text ~')
    // One past the ceiling, to tell a full answer from a cut one.
    expect(params).toEqual(['%user\\_id%', 10_001, 10 * 1024 * 1024])
    expect(sql).toContain('LEFT JOIN data ON budget.bytes <= $3')
    // The order a plain read scans the heap in, whatever plan the filter gets:
    // an index or a parallel scan would hand rows over otherwise.
    expect(sql).toContain('ORDER BY ctid LIMIT $2')
  })

  it('uses ILIKE under ignore case', async () => {
    const { accessor, calls } = makeAccessor(USERS, [])
    await lines(accessor, 'ALI', true)
    expect(calls[2]?.[0]).toContain('"name"::text ILIKE $1')
  })

  it.each<[Row[], string, string]>([
    [
      columns(['id', 'int4'], ['rating', 'float8']),
      '4.5',
      'a double spells digits its cast may spell otherwise',
    ],
    [
      columns(['id', 'int4'], ['at', 'timestamptz']),
      '2026',
      'a timestamp spells digits its cast spells otherwise',
    ],
    [columns(['id', 'int4'], ['price', 'numeric']), 'nan', 'a numeric spells NaN'],
    [
      columns(['id', 'int4'], ['code', 'bpchar']),
      'a b',
      'char(n) pads, and its cast strips the padding',
    ],
    [
      columns(['id', 'int4'], ['doc', 'jsonb']),
      '12',
      'a jsonb number may spell another way in the line',
    ],
    [columns(['id', 'int4'], ['doc', 'jsonb']), '[a', 'a bracket may sit next to a jsonb number'],
    [
      columns(['id', 'int4'], ['tags', '_text', 'A', 'text']),
      '[a',
      "an array's line brackets where its cast braces",
    ],
    [
      columns(['id', 'int4'], ['flags', '_bool', 'A', 'bool']),
      'true',
      "a boolean array's cast spells t and f",
    ],
    [
      columns(['id', 'int4'], ['doc', 'json']),
      'ab',
      "a json value's cast keeps escapes the line decodes",
    ],
    [
      columns(['id', 'int4'], ['span', 'interval']),
      'ab',
      'an interval spells words on one host and keys on the other',
    ],
    [USERS, 'am', 'every row holds the key `name`'],
    [USERS, 'ul', 'a NULL spells `null` in the line'],
    [USERS, 'd":1', 'a quote matches between key and value'],
    [USERS, ':1', 'a colon matches between key and value'],
    [USERS, 'a\tb', 'a control character is spelled as an escape'],
    [[], 'x', 'no columns to ask'],
  ])('declines when a LIKE cannot see every match: %#', async (cols, text, why) => {
    const { accessor, calls } = makeAccessor(cols, [])
    expect(await lines(accessor, text), why).toBeNull()
    expect(calls).toHaveLength(2)
  })

  // A char(n) without a space in the text, a jsonb value, an enum's label and
  // an array of strings or integers hold the text where their cast does; a
  // string can also hold it as an escape's letters.
  it.each<[string[], string[]]>([
    [
      ['code', 'bpchar'],
      ['LIKE', '~'],
    ],
    [['doc', 'jsonb'], ['LIKE']],
    [
      ['status', 'mood', 'E'],
      ['LIKE', '~'],
    ],
    [
      ['tags', '_text', 'A', 'text'],
      ['LIKE', '~'],
    ],
    [['ids', '_int4', 'A', 'int4'], ['LIKE']],
    [
      ['label', 'text'],
      ['LIKE', '~'],
    ],
  ])('searches a column whose cast holds the text: %j', async (column, clauses) => {
    const { accessor, calls } = makeAccessor(columns(column), [])
    expect(await lines(accessor, 'ada')).toBe('')
    const sql = calls[2]?.[0] ?? ''
    const name = `"${column[0] ?? ''}"::text`
    expect(['LIKE', '~'].filter((op) => sql.includes(`${name} ${op}`))).toEqual(clauses)
  })

  // A float, a numeric, a date or a time spells digits and a few marks, never
  // the letters of `ada`, so only the other columns are asked.
  it('leaves out a column that cannot spell the text', async () => {
    const { accessor, calls } = makeAccessor(
      columns(
        ['id', 'int4'],
        ['name', 'text'],
        ['rating', 'float8'],
        ['price', 'numeric'],
        ['at', 'timestamptz'],
      ),
      [{ id: 1, name: 'ada', rating: 4.5, price: 1, at: null }],
    )
    expect(await lines(accessor, 'ada')).toBe(
      '{"id":1,"name":"ada","rating":4.5,"price":1,"at":null}\n',
    )
    const sql = calls[2]?.[0] ?? ''
    expect(sql).toContain('"name"::text LIKE')
    for (const name of ['"rating"', '"price"', '"at"']) expect(sql).not.toContain(name)
  })

  it('answers nothing when no column can spell the text', async () => {
    const { accessor, calls } = makeAccessor(columns(['rating', 'float8'], ['at', 'date']), [])
    expect(await lines(accessor, 'ada')).toBe('')
    expect(calls).toHaveLength(2)
  })

  // A view runs its own query and a parent appends its children's rows, so the
  // rows are numbered in the order a plain read returns them, before the
  // filter, and the number never reaches the line.
  it.each<[Row[]]>([
    [[{ relkind: 'v', relhassubclass: false }]],
    [[{ relkind: 'p', relhassubclass: true }]],
    [[{ relkind: 'r', relhassubclass: true }]],
  ])('numbers a relation read in another order: %j', async (relation) => {
    const { accessor, calls } = makeAccessor(
      USERS,
      [{ __mirage_row: 3, id: 1, name: 'ada' }],
      {},
      100,
      relation,
    )
    expect(await lines(accessor, 'ada')).toBe('{"id":1,"name":"ada"}\n')
    const sql = calls[2]?.[0] ?? ''
    expect(sql).toContain('row_number() OVER () AS "__mirage_row", r.*')
    expect(sql).toContain('ORDER BY "__mirage_row" LIMIT $2')
    expect(sql).not.toContain('ctid')
  })

  it('declines a relation it cannot find', async () => {
    const { accessor, calls } = makeAccessor(USERS, [], {}, 100, [])
    expect(await lines(accessor, 'ada')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('declines more rows than a read returns', async () => {
    // Reading the file refuses it as too large, which only the read says.
    const rows = [0, 1, 2, 3].map((id) => ({ id, name: 'ada' }))
    const { accessor } = makeAccessor(USERS, rows, { maxReadRows: 3 })
    expect(await lines(accessor, 'ada')).toBeNull()
  })

  it.each([65, 1])('declines database and rendered byte overflows (%i)', async (databaseBytes) => {
    const rows = [{ id: 1, name: 'needle' + 'x'.repeat(1024) }]
    const { accessor } = makeAccessor(USERS, rows, { maxReadBytes: 64 }, databaseBytes)
    expect(await lines(accessor, 'needle')).toBeNull()
  })

  it.each(['/public/tables/users/schema.json', '/public/tables/users'])(
    'declines any other file: %s',
    async (other) => {
      const { accessor, calls } = makeAccessor(USERS, [])
      expect(await linesContaining(accessor, path(other), 'ada', false)).toBeNull()
      expect(calls).toHaveLength(0)
    },
  )
})
