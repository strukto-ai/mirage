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

import { mountKey } from '../../utils/key_prefix.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./_client.ts', () => ({
  estimateSize: vi.fn(),
  fetchRows: vi.fn(),
}))

vi.mock('./_schema_json.ts', () => ({
  buildDatabaseJson: vi.fn(),
  buildEntitySchemaJson: vi.fn(),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { PathSpec } from '../../types.ts'
import { resolvePostgresConfig } from '../../resource/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as _client from './_client.ts'
import * as _schema from './_schema_json.ts'
import { read } from './read.ts'

const STUB_DRIVER: PgDriver = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  close: () => Promise.resolve(),
}

function makeAccessor(
  cfgOverrides: Parameters<typeof resolvePostgresConfig>[0] = { dsn: 'postgres://h/db' },
): PostgresAccessor {
  const cfg = resolvePostgresConfig(cfgOverrides)
  return new PostgresAccessor(STUB_DRIVER, cfg)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('read', () => {
  beforeEach(() => {
    vi.mocked(_client.estimateSize).mockReset()
    vi.mocked(_client.fetchRows).mockReset()
    vi.mocked(_schema.buildDatabaseJson).mockReset()
    vi.mocked(_schema.buildEntitySchemaJson).mockReset()
  })

  it('serializes database.json with 2-space indent', async () => {
    vi.mocked(_schema.buildDatabaseJson).mockResolvedValue({
      database: 'db',
      schemas: ['public'],
      tables: [],
      views: [],
      relationships: [],
    })
    const out = await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/database.json',
        directory: '/pg/',
        resourcePath: mountKey('/pg/database.json', '/pg'),
      }),
    )
    const parsed = JSON.parse(decode(out)) as { database: string }
    expect(parsed.database).toBe('db')
    expect(decode(out)).toContain('\n  ')
  })

  it('serializes entity schema.json with kind=table for tables/', async () => {
    vi.mocked(_schema.buildEntitySchemaJson).mockResolvedValue({
      schema: 'public',
      name: 'users',
      kind: 'table',
      columns: [],
      primary_key: [],
      foreign_keys: [],
      indexes: [],
      row_count_estimate: 0,
      size_bytes_estimate: 0,
    })
    await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users/schema.json',
        directory: '/pg/public/tables/users/',
        resourcePath: mountKey('/pg/public/tables/users/schema.json', '/pg'),
      }),
    )
    expect(_schema.buildEntitySchemaJson).toHaveBeenCalledWith(
      expect.anything(),
      'public',
      'users',
      'table',
    )
  })

  it('throws size-guard error when EXPLAIN exceeds rows threshold', async () => {
    vi.mocked(_client.estimateSize).mockResolvedValue([20_000, 100])
    await expect(
      read(
        makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 10_000, maxReadBytes: 1_000_000 }),
        new PathSpec({
          virtual: '/pg/public/tables/users/rows.jsonl',
          directory: '/pg/public/tables/users/',
          resourcePath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
        }),
      ),
    ).rejects.toThrow(/too large to read entirely/)
  })

  it('returns JSONL bytes when row count under threshold', async () => {
    vi.mocked(_client.estimateSize).mockResolvedValue([2, 64])
    vi.mocked(_client.fetchRows).mockResolvedValue([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ])
    const out = await read(
      makeAccessor({ dsn: 'postgres://h/db', maxReadRows: 10_000, maxReadBytes: 1_000_000 }),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        resourcePath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
    )
    expect(decode(out)).toBe('{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n')
  })

  it('honors explicit limit/offset and bypasses size guard', async () => {
    vi.mocked(_client.fetchRows).mockResolvedValue([{ id: 99 }])
    await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        resourcePath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
      undefined,
      { limit: 10, offset: 5 },
    )
    expect(_client.fetchRows).toHaveBeenCalledWith(expect.anything(), 'public', 'users', {
      limit: 10,
      offset: 5,
    })
    expect(_client.estimateSize).not.toHaveBeenCalled()
  })

  it('serializes Date values as ISO strings', async () => {
    vi.mocked(_client.estimateSize).mockResolvedValue([1, 64])
    vi.mocked(_client.fetchRows).mockResolvedValue([{ ts: new Date('2026-04-30T00:00:00.000Z') }])
    const out = await read(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        resourcePath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
    )
    expect(decode(out)).toBe('{"ts":"2026-04-30T00:00:00.000Z"}\n')
  })
})
