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
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  listViews: vi.fn(),
  listMatviews: vi.fn(),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import { resolvePostgresConfig } from '../../resource/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as _client from './_client.ts'
import { readdir } from './readdir.ts'

const STUB_DRIVER: PgDriver = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  close: () => Promise.resolve(),
}

function makeAccessor(): PostgresAccessor {
  const cfg = resolvePostgresConfig({ dsn: 'postgres://localhost/db' })
  return new PostgresAccessor(STUB_DRIVER, cfg)
}

describe('readdir', () => {
  it('lists root: database.json + schemas with mount prefix', async () => {
    vi.mocked(_client.listSchemas).mockResolvedValue(['public', 'analytics'])
    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/pg/',
      directory: '/pg/',
      resourcePath: mountKey('/pg/', '/pg'),
    })
    const out = await readdir(accessor, path)
    expect(out).toEqual(['/pg/database.json', '/pg/public', '/pg/analytics'])
  })

  it('lists schema: tables and views directories', async () => {
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public',
        directory: '/pg/public',
        resourcePath: mountKey('/pg/public', '/pg'),
      }),
    )
    expect(out).toEqual(['/pg/public/tables', '/pg/public/views'])
  })

  it('lists kind=tables', async () => {
    vi.mocked(_client.listTables).mockResolvedValue(['users', 'orders'])
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables',
        directory: '/pg/public/tables',
        resourcePath: mountKey('/pg/public/tables', '/pg'),
      }),
    )
    expect(out).toEqual(['/pg/public/tables/users', '/pg/public/tables/orders'])
  })

  it('lists kind=views: union of views and matviews, sorted', async () => {
    vi.mocked(_client.listViews).mockResolvedValue(['z_view'])
    vi.mocked(_client.listMatviews).mockResolvedValue(['a_mview', 'z_view'])
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/views',
        directory: '/pg/public/views',
        resourcePath: mountKey('/pg/public/views', '/pg'),
      }),
    )
    expect(out).toEqual(['/pg/public/views/a_mview', '/pg/public/views/z_view'])
  })

  it('lists entity: schema.json + rows.jsonl', async () => {
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users',
        directory: '/pg/public/tables/users',
        resourcePath: mountKey('/pg/public/tables/users', '/pg'),
      }),
    )
    expect(out).toEqual([
      '/pg/public/tables/users/schema.json',
      '/pg/public/tables/users/rows.jsonl',
    ])
  })

  it('caches root listing in index when provided', async () => {
    vi.mocked(_client.listSchemas).mockResolvedValue(['public'])
    const index = new RAMIndexCacheStore()
    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/pg/',
      directory: '/pg/',
      resourcePath: mountKey('/pg/', '/pg'),
    })
    await readdir(accessor, path, index)
    vi.mocked(_client.listSchemas).mockClear()
    await readdir(accessor, path, index)
    expect(_client.listSchemas).not.toHaveBeenCalled()
  })

  it('throws ENOENT for unsupported scopes', async () => {
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({
          virtual: '/pg/public/tables/users/schema.json',
          directory: '/pg/public/tables/users/',
          resourcePath: mountKey('/pg/public/tables/users/schema.json', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
