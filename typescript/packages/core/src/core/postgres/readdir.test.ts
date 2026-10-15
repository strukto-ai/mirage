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

vi.mock('./client.ts', () => ({
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  listViews: vi.fn(),
  listMatviews: vi.fn(),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { PathSpec, type DirListing, type FileStat } from '../../types.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { resolvePostgresConfig } from '../../vfs/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as client from './client.ts'
import { readdir } from './readdir.ts'

function names(listed: readonly FileStat[] | DirListing): string[] {
  return rowsOf(listed).map((row) => row.name)
}

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
    vi.mocked(client.listSchemas).mockResolvedValue(['public', 'analytics'])
    const accessor = makeAccessor()
    const path = new PathSpec({
      virtual: '/pg/',
      directory: '/pg/',
      vfsPath: mountKey('/pg/', '/pg'),
    })
    const out = await readdir(accessor, path)
    expect(names(out)).toEqual(['database.json', 'public', 'analytics'])
  })

  it('lists schema: tables and views directories', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public',
        directory: '/pg/public',
        vfsPath: mountKey('/pg/public', '/pg'),
      }),
    )
    expect(names(out)).toEqual(['tables', 'views'])
  })

  it('lists kind=tables', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    vi.mocked(client.listTables).mockResolvedValue(['users', 'orders'])
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables',
        directory: '/pg/public/tables',
        vfsPath: mountKey('/pg/public/tables', '/pg'),
      }),
    )
    expect(names(out)).toEqual(['users', 'orders'])
  })

  it('lists kind=views: union of views and matviews, sorted', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    vi.mocked(client.listViews).mockResolvedValue(['z_view'])
    vi.mocked(client.listMatviews).mockResolvedValue(['a_mview', 'z_view'])
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/views',
        directory: '/pg/public/views',
        vfsPath: mountKey('/pg/public/views', '/pg'),
      }),
    )
    expect(names(out)).toEqual(['a_mview', 'z_view'])
  })

  it('lists entity: schema.json + semantic.json + rows.jsonl', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    vi.mocked(client.listTables).mockResolvedValue(['users'])
    const out = await readdir(
      makeAccessor(),
      new PathSpec({
        virtual: '/pg/public/tables/users',
        directory: '/pg/public/tables/users',
        vfsPath: mountKey('/pg/public/tables/users', '/pg'),
      }),
    )
    expect(names(out)).toEqual(['schema.json', 'semantic.json', 'rows.jsonl'])
  })

  it('throws ENOENT for unsupported scopes', async () => {
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({
          virtual: '/pg/public/tables/users/schema.json',
          directory: '/pg/public/tables/users/',
          vfsPath: mountKey('/pg/public/tables/users/schema.json', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a schema that does not exist', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({
          virtual: '/pg/nope.txt',
          directory: '/pg/nope.txt',
          vfsPath: mountKey('/pg/nope.txt', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a kind directory under a schema that does not exist', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    vi.mocked(client.listTables).mockResolvedValue([])
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({
          virtual: '/pg/nope/tables',
          directory: '/pg/nope/tables',
          vfsPath: mountKey('/pg/nope/tables', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an entity that does not exist', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    vi.mocked(client.listTables).mockResolvedValue(['users'])
    await expect(
      readdir(
        makeAccessor(),
        new PathSpec({
          virtual: '/pg/public/tables/ghost',
          directory: '/pg/public/tables/ghost',
          vfsPath: mountKey('/pg/public/tables/ghost', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // The entity guard stands in for the listing chain, so it has to answer for
  // the schema as well: it used to check only that the table existed, and a
  // table under a schema `schemas` leaves out listed, stat'd and read as if
  // the mount could see it.
  it('refuses an entity under a schema outside schemas', async () => {
    vi.mocked(client.listSchemas).mockImplementation((_accessor, allow) =>
      Promise.resolve(['public', 'secret'].filter((s) => allow == null || allow.includes(s))),
    )
    vi.mocked(client.listTables).mockClear()
    vi.mocked(client.listTables).mockResolvedValue(['users'])
    const accessor = new PostgresAccessor(
      STUB_DRIVER,
      resolvePostgresConfig({ dsn: 'postgres://localhost/db', schemas: ['public'] }),
    )
    await expect(
      readdir(
        accessor,
        new PathSpec({
          virtual: '/pg/secret/tables/users',
          directory: '/pg/secret/tables/users',
          vfsPath: mountKey('/pg/secret/tables/users', '/pg'),
        }),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(client.listTables).not.toHaveBeenCalled()
  })
})
