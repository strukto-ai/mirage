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

import type * as _ClientType from './_client.ts'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./_client.ts', async () => {
  const actual = await vi.importActual<typeof _ClientType>('./_client.ts')
  return {
    ...actual,
    listTables: vi.fn(),
    listViews: vi.fn(),
    listMatviews: vi.fn(),
    listSchemas: vi.fn(),
  }
})

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { resolvePostgresConfig } from '../../resource/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as _client from './_client.ts'
import { formatGrepResults, searchEntity, searchKind } from './search.ts'

function makeAccessor(): { accessor: PostgresAccessor; query: ReturnType<typeof vi.fn> } {
  const cfg = resolvePostgresConfig({ dsn: 'postgres://localhost/db' })
  const query = vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 }))
  const driver: PgDriver = {
    query: query as unknown as PgDriver['query'],
    close: () => Promise.resolve(),
  }
  return { accessor: new PostgresAccessor(driver, cfg), query }
}

describe('searchEntity', () => {
  it('returns [] when no text-typed columns', async () => {
    const { accessor, query } = makeAccessor()
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    expect(await searchEntity(accessor, 'public', 'tables', 't', 'foo', 10)).toEqual([])
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('builds an OR-of-LIKE WHERE across text columns (case-sensitive default)', async () => {
    const { accessor, query } = makeAccessor()
    query
      .mockResolvedValueOnce({
        rows: [{ column_name: 'name' }, { column_name: 'email' }],
        rowCount: 2,
      })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })

    const out = await searchEntity(accessor, 'public', 'tables', 'users', 'foo', 10)
    expect(out).toEqual([{ id: 1 }])
    const sql = query.mock.calls[1]?.[0] as string
    expect(sql).toBe(
      'SELECT * FROM "public"."users" WHERE "name"::text LIKE $1 OR "email"::text LIKE $1 LIMIT $2',
    )
    expect(query.mock.calls[1]?.[1]).toEqual(['%foo%', 10])
  })

  it('uses ILIKE and escapes LIKE wildcards when case-insensitive', async () => {
    const { accessor, query } = makeAccessor()
    query
      .mockResolvedValueOnce({ rows: [{ column_name: 'name' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    await searchEntity(accessor, 'public', 'tables', 'users', 'user_id', 10, true)
    const sql = query.mock.calls[1]?.[0] as string
    expect(sql).toBe('SELECT * FROM "public"."users" WHERE "name"::text ILIKE $1 LIMIT $2')
    // `_` is escaped so it matches literally, not as a LIKE wildcard.
    expect(query.mock.calls[1]?.[1]).toEqual(['%user\\_id%', 10])
  })
})

describe('searchKind', () => {
  it('walks tables and emits matches per entity', async () => {
    vi.mocked(_client.listTables).mockResolvedValue(['users', 'orders'])
    const { accessor, query } = makeAccessor()
    query
      .mockResolvedValueOnce({ rows: [{ column_name: 'name' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ column_name: 'name' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const out = await searchKind(accessor, 'public', 'tables', 'foo', 10)
    expect(out).toEqual([{ schema: 'public', kind: 'tables', entity: 'users', rows: [{ id: 1 }] }])
  })
})

describe('formatGrepResults', () => {
  it('emits one line per matching row with path-prefix', () => {
    const lines = formatGrepResults([
      { schema: 'public', kind: 'tables', entity: 'users', rows: [{ id: 1, name: 'a' }] },
      { schema: 'public', kind: 'tables', entity: 'users', rows: [{ id: 2, name: 'b' }] },
    ])
    expect(lines).toEqual([
      'public/tables/users/rows.jsonl:{"id":1,"name":"a"}',
      'public/tables/users/rows.jsonl:{"id":2,"name":"b"}',
    ])
  })
})
