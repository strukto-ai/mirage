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

import type * as _ClientType from './client.ts'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof _ClientType>('./client.ts')
  return {
    ...actual,
    listTables: vi.fn(),
    listViews: vi.fn(),
    listMatviews: vi.fn(),
    listSchemas: vi.fn(),
  }
})

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { resolvePostgresConfig } from '../../vfs/postgres/config.ts'
import type { SearchQuery } from '../../vfs/types.ts'
import type { PgDriver } from './_driver.ts'
import * as client from './client.ts'
import { formatGrepResults, searchEntity, searchKind } from './search.ts'

type Row = Record<string, unknown>

function columns(...pairs: [string, string][]): Row[] {
  // What `fetchColumns` reads off information_schema.
  return pairs.map(([name, type]) => ({ column_name: name, data_type: type, is_nullable: 'YES' }))
}

const USERS = columns(['id', 'integer'], ['name', 'text'])

// A driver whose first query answers the column list and every other one the
// rows, recording the SQL and parameters it was asked.
function makeAccessor(
  cols: Row[],
  rows: Row[],
  maxReadRows = 10_000,
  maxReadBytes = 10 * 1024 * 1024,
  databaseBytes = 100,
): { accessor: PostgresAccessor; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = []
  const driver: PgDriver = {
    query: ((sql: string, params: unknown[] = []) => {
      calls.push([sql, params])
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({ rows: cols, rowCount: cols.length })
      }
      if (sql.includes('EXPLAIN')) {
        return Promise.resolve({
          rows: [{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': 1, 'Plan Width': 8 } }] }],
          rowCount: 1,
        })
      }
      if (sql.startsWith('WITH data AS MATERIALIZED')) {
        return Promise.resolve({
          rows:
            rows.length === 0
              ? [{ __mirage_bytes: 0 }]
              : rows.map((row) => ({ ...row, __mirage_bytes: databaseBytes })),
          rowCount: rows.length,
        })
      }
      const limit = typeof params[params.length - 2] === 'number' ? Number(params[0]) : rows.length
      return Promise.resolve({ rows: rows.slice(0, limit + 1), rowCount: rows.length })
    }) as PgDriver['query'],
    close: () => Promise.resolve(),
  }
  const cfg = resolvePostgresConfig({ dsn: 'postgres://localhost/db', maxReadRows, maxReadBytes })
  return { accessor: new PostgresAccessor(driver, cfg), calls }
}

function query(pattern: string, ignoreCase = false): SearchQuery {
  return {
    query: pattern,
    options: {
      grep: { ignore_case: ignoreCase, fixed_string: false, whole_word: false, syntax: 'basic' },
    },
  }
}

describe('searchEntity', () => {
  it.each(['\u0085', '\u2028', '\u2029'])(
    'preserves Unicode separator %j inside a JSONL row',
    async (separator) => {
      const { accessor } = makeAccessor(USERS, [{ id: 1, name: `left${separator}right` }])
      expect(await searchEntity(accessor, 'public', 'tables', 'users', query('name'))).toEqual([
        `{"id":1,"name":"left${separator}right"}`,
      ])
    },
  )

  it('answers the lines grep would print', async () => {
    const { accessor } = makeAccessor(USERS, [
      { id: 1, name: 'alice' },
      { id: 2, name: 'alex' },
    ])
    expect(await searchEntity(accessor, 'public', 'tables', 'users', query('al'))).toEqual([
      '{"id":1,"name":"alice"}',
      '{"id":2,"name":"alex"}',
    ])
  })

  it('casts every column and takes rows a line escapes', async () => {
    const { accessor, calls } = makeAccessor(USERS, [])
    await searchEntity(accessor, 'public', 'tables', 'users', query('user_id'))
    const [sql, params] = calls[1] ?? ['', []]
    expect(sql).not.toContain('ILIKE')
    expect(sql).toContain('"id"::text LIKE $1')
    expect(sql).toContain('"name"::text LIKE $1')
    expect(sql).toContain(`"name" ~ '[[:cntrl:]]'`)
    expect(sql).not.toContain('"id" ~')
    // `_` is escaped so it matches literally; one past the ceiling tells a
    // full answer from a cut one.
    expect(params).toEqual(['%user\\_id%', 10_001, 10 * 1024 * 1024])
    expect(sql).toContain('LEFT JOIN data ON budget.bytes <= $3')
  })

  it('folds case with ILIKE under -i', async () => {
    const { accessor, calls } = makeAccessor(USERS, [])
    await searchEntity(accessor, 'public', 'tables', 'users', query('ALI', true))
    expect(calls[1]?.[0]).toContain('ILIKE')
  })

  it.each([65, 1])('refuses database and rendered byte overflows (%i)', async (databaseBytes) => {
    const { accessor } = makeAccessor(
      USERS,
      [{ name: 'needle' + 'x'.repeat(1024) }],
      10_000,
      64,
      databaseBytes,
    )
    await expect(
      searchEntity(accessor, 'public', 'tables', 'users', query('needle')),
    ).rejects.toMatchObject({ code: 'EFBIG', virtualPath: 'public/tables/users/rows.jsonl' })
  })

  // A tab renders as `\t` in the line, so `t` matches it there while no LIKE
  // over the value would: the row is a candidate and the matcher decides.
  it('decides a candidate with the matcher grep compiles', async () => {
    const { accessor } = makeAccessor(columns(['id', 'integer'], ['body', 'text']), [
      { id: 1, body: 'a\tb' },
      { id: 2, body: 'x\ny' },
    ])
    expect(await searchEntity(accessor, 'public', 'tables', 't', query('t'))).toEqual([
      '{"id":1,"body":"a\\tb"}',
    ])
  })

  // The push-down printed its LIKE answer as grep's, and a LIKE per text column
  // never saw a number, a key, the text between values or a NULL, so grep over
  // rows.jsonl found rows the push-down did not. Such a search reads the file.
  it.each([
    [columns(['id', 'integer'], ['rating', 'double precision']), '4.5'],
    [columns(['id', 'integer'], ['at', 'timestamp with time zone']), '2026'],
    [USERS, 'am'],
    [USERS, 'ul'],
    [USERS, ':1'],
  ])('scans the file when a LIKE cannot see every match (%#)', async (cols, pattern) => {
    const { accessor, calls } = makeAccessor(cols, [{ id: 1, rating: 4.5, name: null, at: '2026' }])
    const lines = await searchEntity(accessor, 'public', 'tables', 't', query(pattern))
    expect(lines).toHaveLength(1)
    expect(calls.some(([sql]) => sql.includes('WITH data AS MATERIALIZED'))).toBe(true)
  })

  // It used to print the first `defaultSearchLimit` matches and drop the rest
  // in silence; more than one read may return is refused instead.
  it('refuses more candidates than one read may return', async () => {
    const rows = Array.from({ length: 4 }, (_, id) => ({ id, name: 'ada' }))
    const { accessor } = makeAccessor(USERS, rows, 3)
    await expect(
      searchEntity(accessor, 'public', 'tables', 'users', query('ada')),
    ).rejects.toMatchObject({ code: 'EFBIG', virtualPath: 'public/tables/users/rows.jsonl' })
  })

  it('matches nothing in a relation with no columns', async () => {
    const { accessor } = makeAccessor([], [])
    expect(await searchEntity(accessor, 'public', 'tables', 't', query('x'))).toEqual([])
  })
})

describe('searchKind', () => {
  it('collects each entity with matches under one kind', async () => {
    vi.mocked(client.listTables).mockResolvedValue(['users', 'empty'])
    const { accessor } = makeAccessor(USERS, [{ id: 1, name: 'ada' }])
    const found = await searchKind(accessor, 'public', 'tables', query('ada'))
    expect(found.map((m) => m.entity)).toEqual(['users', 'empty'])
    expect(formatGrepResults(found)[0]?.[1]).toBe(
      'public/tables/users/rows.jsonl:{"id":1,"name":"ada"}',
    )
  })
})
