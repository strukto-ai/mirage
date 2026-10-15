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

import { describe, expect, it, vi } from 'vitest'
import { PostgresAccessor } from '../../accessor/postgres.ts'
import { resolvePostgresConfig } from '../../vfs/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as client from './client.ts'

function makeAccessor(
  rows: unknown[] | ((sql: string, params?: readonly unknown[]) => unknown[]),
): { accessor: PostgresAccessor; query: ReturnType<typeof vi.fn> } {
  const cfg = resolvePostgresConfig({ dsn: 'postgres://localhost/db' })
  const query = vi.fn((sql: string, params?: readonly unknown[]) => {
    const r = typeof rows === 'function' ? rows(sql, params) : rows
    return Promise.resolve({ rows: r, rowCount: r.length })
  })
  const driver: PgDriver = {
    query: query as unknown as PgDriver['query'],
    close: () => Promise.resolve(),
  }
  return { accessor: new PostgresAccessor(driver, cfg), query }
}

describe('quoteIdent', () => {
  it('escapes embedded quotes', () => {
    expect(client.quoteIdent('users')).toBe('"users"')
    expect(client.quoteIdent('a"b')).toBe('"a""b"')
  })

  it('neutralizes an injection payload', () => {
    const payload = 'books" CROSS JOIN secret AS "s'
    const quoted = client.quoteIdent(payload)
    // Every embedded quote is doubled, so the payload cannot terminate the
    // identifier and become executable SQL: it stays one (nonexistent) name.
    expect(quoted).toBe('"books"" CROSS JOIN secret AS ""s"')
    // After stripping the outer wrapper and collapsing every doubled-quote
    // pair, no lone quote survives to break out of the identifier.
    expect(quoted.slice(1, -1).replace(/""/g, '')).not.toContain('"')
  })
})

describe('countRows', () => {
  it('quotes a malicious relation name instead of interpolating it raw', async () => {
    const { accessor, query } = makeAccessor([{ count: 0 }])
    await client.countRows(accessor, 'public', 'books" CROSS JOIN secret AS "s')
    const sql = query.mock.calls[0]?.[0] as string
    expect(sql).toContain('"books"" CROSS JOIN secret AS ""s"')
    expect(sql).not.toContain('FROM "public"."books" CROSS JOIN secret')
  })
})

describe('listSchemas', () => {
  it('filters system schemas via SQL and returns names', async () => {
    const { accessor, query } = makeAccessor([
      { schema_name: 'analytics' },
      { schema_name: 'public' },
    ])
    expect(await client.listSchemas(accessor, null)).toEqual(['analytics', 'public'])
    const sql = query.mock.calls[0]?.[0] as string
    expect(sql).toContain('information_schema.schemata')
    expect(sql).toContain("NOT IN ('pg_catalog', 'information_schema')")
    expect(sql).toContain("NOT LIKE 'pg_%'")
  })

  it('honors the allowlist', async () => {
    const { accessor } = makeAccessor([{ schema_name: 'public' }, { schema_name: 'analytics' }])
    expect(await client.listSchemas(accessor, ['public'])).toEqual(['public'])
  })
})

describe('listTables / listViews / listMatviews', () => {
  it('listTables filters by table_type=BASE TABLE', async () => {
    const { accessor, query } = makeAccessor([{ table_name: 'a' }, { table_name: 'b' }])
    expect(await client.listTables(accessor, 'public')).toEqual(['a', 'b'])
    expect(query.mock.calls[0]?.[0]).toContain("table_type = 'BASE TABLE'")
    expect(query.mock.calls[0]?.[1]).toEqual(['public'])
  })

  it('listViews queries information_schema.views', async () => {
    const { accessor, query } = makeAccessor([{ table_name: 'v1' }])
    expect(await client.listViews(accessor, 'public')).toEqual(['v1'])
    expect(query.mock.calls[0]?.[0]).toContain('information_schema.views')
  })

  it('listMatviews queries pg_matviews', async () => {
    const { accessor, query } = makeAccessor([{ name: 'm1' }])
    expect(await client.listMatviews(accessor, 'public')).toEqual(['m1'])
    expect(query.mock.calls[0]?.[0]).toContain('pg_matviews')
  })
})

describe('countRows', () => {
  it('quotes identifiers and returns the bigint count', async () => {
    const { accessor, query } = makeAccessor([{ count: '12453' }])
    expect(await client.countRows(accessor, 'public', 'users')).toBe(12453)
    expect(query.mock.calls[0]?.[0]).toBe('SELECT COUNT(*) AS count FROM "public"."users"')
  })
})

describe('estimateSize', () => {
  it('parses EXPLAIN JSON object form (real column name "QUERY PLAN")', async () => {
    const plan = [{ Plan: { 'Plan Rows': 5000, 'Plan Width': 64 } }]
    const { accessor } = makeAccessor([{ 'QUERY PLAN': plan }])
    expect(await client.estimateSize(accessor, 'public', 'users')).toEqual([5000, 64])
  })

  it('parses EXPLAIN JSON returned as string', async () => {
    const plan = JSON.stringify([{ Plan: { 'Plan Rows': 5000, 'Plan Width': 64 } }])
    const { accessor } = makeAccessor([{ 'QUERY PLAN': plan }])
    expect(await client.estimateSize(accessor, 'public', 'users')).toEqual([5000, 64])
  })

  it('escapes embedded double quotes in identifiers', async () => {
    const plan = [{ Plan: { 'Plan Rows': 1, 'Plan Width': 1 } }]
    const { accessor, query } = makeAccessor([{ 'QUERY PLAN': plan }])
    await client.estimateSize(accessor, 'pub"lic', 'us"ers')
    expect(query.mock.calls[0]?.[0]).toBe(
      'EXPLAIN (FORMAT JSON) SELECT * FROM "pub""lic"."us""ers"',
    )
  })
})

describe('estimatedRowCount / tableSizeBytes', () => {
  it('estimatedRowCount returns 0 when row missing', async () => {
    const { accessor } = makeAccessor([])
    expect(await client.estimatedRowCount(accessor, 'public', 'x')).toBe(0)
  })

  it('estimatedRowCount casts reltuples to int', async () => {
    const { accessor } = makeAccessor([{ reltuples: '42' }])
    expect(await client.estimatedRowCount(accessor, 'public', 'x')).toBe(42)
  })

  it('tableSizeBytes returns 0 when missing', async () => {
    const { accessor } = makeAccessor([])
    expect(await client.tableSizeBytes(accessor, 'public', 'x')).toBe(0)
  })

  it('tableSizeBytes casts pg_total_relation_size to int', async () => {
    const { accessor } = makeAccessor([{ size: '2097152' }])
    expect(await client.tableSizeBytes(accessor, 'public', 'x')).toBe(2097152)
  })
})

describe('fetchRows', () => {
  it('quotes identifiers, binds limit/offset and orders by the key', async () => {
    const { accessor, query } = makeAccessor((sql) =>
      sql.includes("contype = 'p'") ? [{ column_name: 'id' }] : [{ id: 1, name: 'a' }],
    )
    const out = await client.fetchRows(accessor, 'public', 'users', { limit: 10, offset: 5 })
    expect(out).toEqual([{ id: 1, name: 'a' }])
    expect(query.mock.calls[1]?.[0]).toBe(
      'SELECT * FROM "public"."users" ORDER BY "id" LIMIT $1 OFFSET $2',
    )
    expect(query.mock.calls[1]?.[1]).toEqual([10, 5])
  })
})

describe('fetchColumns', () => {
  it('maps is_nullable=YES to nullable=true', async () => {
    const { accessor } = makeAccessor([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'name', data_type: 'text', is_nullable: 'YES' },
    ])
    expect(await client.fetchColumns(accessor, 'public', 'users')).toEqual([
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'name', type: 'text', nullable: true },
    ])
  })
})

// Twin of test_fetch_a_key: another table's constraint can share the key's
// name, and a parent's key does not cover its inheritance children's rows.
describe.each([
  ['fetchPrimaryKey', client.fetchPrimaryKey, 'tc.table_name = kcu.table_name'],
  ['fetchRowKey', client.fetchRowKey, "(c.relkind = 'p' OR NOT c.relhassubclass)"],
] as const)('%s', (_name, fetch, clause) => {
  it('returns the key columns in key order', async () => {
    const { accessor, query } = makeAccessor([{ column_name: 'a' }, { column_name: 'b' }])
    expect(await fetch(accessor, 'public', 'users')).toEqual(['a', 'b'])
    expect(query.mock.calls[0]?.[0]).toContain(clause)
  })
})

// Twin of test_rows_after_a_key_come_within_a_byte_budget. The next page
// starts after the key's text: node-pg reads a timestamp key as a millisecond
// Date, which would sort before the row it came from.
describe('fetchRowsAfter', () => {
  const after = ['1970-01-01 00:00:00+00']
  const exact = '1970-01-01 00:00:00.000001+00'
  it.each([
    [12, [[{ at: new Date(0) }], [exact]]],
    [101, [null, after]],
  ])('answers a %i-byte page against a 100-byte budget', async (size, expected) => {
    const { accessor, query } = makeAccessor([
      { at: new Date(0), __mirage_key0: exact, __mirage_bytes: size },
    ])
    expect(
      await client.fetchRowsAfter(
        accessor,
        'public',
        'events',
        ['at'],
        after,
        5,
        new Set(['at']),
        100,
      ),
    ).toEqual(expected)
    expect(query.mock.calls[0]?.[0]).toContain(
      'SELECT *, "at"::text AS "__mirage_key0" FROM "public"."events" WHERE ("at") > ($2) ' +
        'ORDER BY "at" LIMIT $1',
    )
    expect(query.mock.calls[0]?.[1]).toEqual([5, ...after, 100])
  })
})

describe('fetchForeignKeys', () => {
  it('groups multi-column FKs and preserves column order via WITH ORDINALITY', async () => {
    const { accessor, query } = makeAccessor([
      {
        constraint_name: 'fk1',
        from_column: 'a',
        to_column: 'x',
        ord: 1,
        to_schema: 'public',
        to_table: 'other',
      },
      {
        constraint_name: 'fk1',
        from_column: 'b',
        to_column: 'y',
        ord: 2,
        to_schema: 'public',
        to_table: 'other',
      },
    ])
    const fks = await client.fetchForeignKeys(accessor, 'public', 't')
    expect(fks).toEqual([
      {
        columns: ['a', 'b'],
        references: { schema: 'public', table: 'other', columns: ['x', 'y'] },
      },
    ])
    expect(query.mock.calls[0]?.[0]).toContain('unnest(con.conkey) WITH ORDINALITY')
    expect(query.mock.calls[0]?.[0]).toContain('unnest(con.confkey) WITH ORDINALITY')
  })
})

describe('fetchIndexes', () => {
  it('passes through unique flag and column array', async () => {
    const { accessor } = makeAccessor([{ name: 'i1', unique: true, columns: ['a', 'b'] }])
    expect(await client.fetchIndexes(accessor, 'public', 't')).toEqual([
      { name: 'i1', columns: ['a', 'b'], unique: true },
    ])
  })
})

describe('fetchAllRelationships', () => {
  it('returns [] when schemas list is empty', async () => {
    const { accessor, query } = makeAccessor([])
    expect(await client.fetchAllRelationships(accessor, [])).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('groups by (from_schema, from_table, constraint_name)', async () => {
    const { accessor } = makeAccessor([
      {
        constraint_name: 'fk1',
        from_schema: 'public',
        from_table: 'orders',
        from_column: 'user_id',
        to_column: 'id',
        ord: 1,
        to_schema: 'public',
        to_table: 'users',
      },
    ])
    const rels = await client.fetchAllRelationships(accessor, ['public'])
    expect(rels).toEqual([
      {
        from: { schema: 'public', table: 'orders', columns: ['user_id'] },
        to: { schema: 'public', table: 'users', columns: ['id'] },
        kind: 'many_to_one',
      },
    ])
  })
})

describe('fetchBoundedRows', () => {
  it.each([0, 100, 101])('handles a %i-byte result and a colliding column', async (size) => {
    const { accessor, query } = makeAccessor((sql) =>
      sql.includes('information_schema.columns')
        ? [{ column_name: '__mirage_bytes', data_type: 'text', is_nullable: 'YES' }]
        : sql.includes("contype = 'p'")
          ? []
          : [{ __mirage_bytes: null, __mirage_bytes_: size }],
    )
    const rows = await client.fetchBoundedRows(accessor, 'public', 'users', {
      limit: 11,
      maxBytes: 100,
    })
    expect(rows).toEqual(size === 0 ? [] : size > 100 ? null : [{ __mirage_bytes: null }])
    expect(query.mock.calls[2]?.[1]).toEqual([11, 100])
  })
})
