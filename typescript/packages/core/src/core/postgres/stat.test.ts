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
import { describe, expect, it, vi } from 'vitest'

vi.mock('./_client.ts', () => ({
  fetchColumns: vi.fn(),
  estimatedRowCount: vi.fn(),
  tableSizeBytes: vi.fn(),
  listSchemas: vi.fn(() => Promise.resolve(['public', 'analytics'])),
  listTables: vi.fn(() => Promise.resolve(['users'])),
  listViews: vi.fn(() => Promise.resolve(['daily_revenue'])),
  listMatviews: vi.fn(() => Promise.resolve([])),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { FileType, PathSpec } from '../../types.ts'
import { resolvePostgresConfig } from '../../resource/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as _client from './_client.ts'
import { stat } from './stat.ts'

const STUB_DRIVER: PgDriver = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  close: () => Promise.resolve(),
}

function makeAccessor(): PostgresAccessor {
  const cfg = resolvePostgresConfig({ dsn: 'postgres://localhost/db' })
  return new PostgresAccessor(STUB_DRIVER, cfg)
}

describe('stat', () => {
  it('marks root as DIRECTORY', async () => {
    const r = await stat(
      makeAccessor(),
      new PathSpec({ virtual: '/pg/', directory: '/pg/', resourcePath: mountKey('/pg/', '/pg') }),
    )
    expect(r.name).toBe('/')
    expect(r.type).toBe(FileType.DIRECTORY)
  })

  it('marks database.json as JSON', async () => {
    const r = await stat(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/database.json',
        directory: '/pg/',
        resourcePath: mountKey('/pg/database.json', '/pg'),
      }),
    )
    expect(r.type).toBe(FileType.JSON)
    expect(r.name).toBe('database.json')
  })

  it('marks schema/kind/entity as DIRECTORY with extras', async () => {
    const r = await stat(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users',
        directory: '/pg/public/tables/',
        resourcePath: mountKey('/pg/public/tables/users', '/pg'),
      }),
    )
    expect(r.type).toBe(FileType.DIRECTORY)
    expect(r.extra).toEqual({ schema: 'public', kind: 'tables', name: 'users' })
  })

  it('marks rows.jsonl as TEXT with null size (storage size in extra) + fingerprint', async () => {
    vi.mocked(_client.fetchColumns).mockResolvedValue([
      { name: 'id', type: 'uuid', nullable: false },
    ])
    vi.mocked(_client.estimatedRowCount).mockResolvedValue(42)
    vi.mocked(_client.tableSizeBytes).mockResolvedValue(4096)
    const r = await stat(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users/rows.jsonl',
        directory: '/pg/public/tables/users/',
        resourcePath: mountKey('/pg/public/tables/users/rows.jsonl', '/pg'),
      }),
    )
    expect(r.type).toBe(FileType.TEXT)
    expect(r.size).toBeNull()
    expect(r.extra.size_bytes).toBe(4096)
    expect(r.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(r.extra.row_count).toBe(42)
  })

  it('throws ENOENT for invalid path', async () => {
    await expect(
      stat(
        makeAccessor(),
        new PathSpec({
          virtual: '/pg/public/sequences',
          directory: '/pg/public/',
          resourcePath: mountKey('/pg/public/sequences', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws ENOENT for a non-existent schema', async () => {
    await expect(
      stat(
        makeAccessor(),
        new PathSpec({
          virtual: '/pg/__nf_missing__.txt',
          directory: '/pg/',
          resourcePath: mountKey('/pg/__nf_missing__.txt', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
