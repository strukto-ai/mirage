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

vi.mock('./client.ts', () => ({
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  listViews: vi.fn(),
  listMatviews: vi.fn(),
  estimatedRowCount: vi.fn(),
  tableSizeBytes: vi.fn(),
  fetchAllRelationships: vi.fn(),
  fetchColumns: vi.fn(),
  fetchPrimaryKey: vi.fn(),
  fetchForeignKeys: vi.fn(),
  fetchIndexes: vi.fn(),
}))

import { PostgresAccessor } from '../../accessor/postgres.ts'
import { resolvePostgresConfig } from '../../vfs/postgres/config.ts'
import type { PgDriver } from './_driver.ts'
import * as client from './client.ts'
import { buildDatabaseJson, buildEntitySchemaJson, databaseNameFromDsn } from './_schema_json.ts'

const STUB_DRIVER: PgDriver = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  close: () => Promise.resolve(),
}

function makeAccessor(dsn = 'postgres://localhost/acme_prod'): PostgresAccessor {
  const cfg = resolvePostgresConfig({ dsn })
  return new PostgresAccessor(STUB_DRIVER, cfg)
}

describe('buildDatabaseJson', () => {
  it('aggregates schemas, tables, views, matviews, and relationships', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue(['public'])
    vi.mocked(client.listTables).mockResolvedValue(['users', 'orders'])
    vi.mocked(client.listViews).mockResolvedValue(['customer_360'])
    vi.mocked(client.listMatviews).mockResolvedValue(['daily_revenue'])
    vi.mocked(client.estimatedRowCount).mockResolvedValueOnce(100).mockResolvedValueOnce(200)
    vi.mocked(client.tableSizeBytes).mockResolvedValueOnce(1024).mockResolvedValueOnce(2048)
    vi.mocked(client.fetchAllRelationships).mockResolvedValue([
      {
        from: { schema: 'public', table: 'orders', columns: ['user_id'] },
        to: { schema: 'public', table: 'users', columns: ['id'] },
        kind: 'many_to_one',
      },
    ])

    const result = await buildDatabaseJson(makeAccessor())
    expect(result.database).toBe('acme_prod')
    expect(result.schemas).toEqual(['public'])
    expect(result.tables).toEqual([
      { schema: 'public', name: 'users', row_count_estimate: 100, size_bytes_estimate: 1024 },
      { schema: 'public', name: 'orders', row_count_estimate: 200, size_bytes_estimate: 2048 },
    ])
    expect(result.views).toEqual([
      { schema: 'public', name: 'customer_360', kind: 'view' },
      { schema: 'public', name: 'daily_revenue', kind: 'materialized' },
    ])
    expect(result.relationships).toHaveLength(1)
  })

  it('handles empty database', async () => {
    vi.mocked(client.listSchemas).mockResolvedValue([])
    vi.mocked(client.fetchAllRelationships).mockResolvedValue([])
    const result = await buildDatabaseJson(makeAccessor())
    expect(result.schemas).toEqual([])
    expect(result.tables).toEqual([])
    expect(result.views).toEqual([])
    expect(result.relationships).toEqual([])
  })
})

describe('buildEntitySchemaJson', () => {
  it('annotates columns with primary_key and references for tables', async () => {
    vi.mocked(client.fetchColumns).mockResolvedValue([
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'team_id', type: 'uuid', nullable: true },
      { name: 'email', type: 'text', nullable: false },
    ])
    vi.mocked(client.fetchPrimaryKey).mockResolvedValue(['id'])
    vi.mocked(client.fetchForeignKeys).mockResolvedValue([
      {
        columns: ['team_id'],
        references: { schema: 'public', table: 'teams', columns: ['id'] },
      },
    ])
    vi.mocked(client.fetchIndexes).mockResolvedValue([
      { name: 'users_email_idx', columns: ['email'], unique: true },
    ])
    vi.mocked(client.estimatedRowCount).mockResolvedValue(42)
    vi.mocked(client.tableSizeBytes).mockResolvedValue(4096)

    const result = await buildEntitySchemaJson(makeAccessor(), 'public', 'users', 'table')
    expect(result.schema).toBe('public')
    expect(result.name).toBe('users')
    expect(result.kind).toBe('table')
    expect(result.row_count_estimate).toBe(42)
    expect(result.size_bytes_estimate).toBe(4096)
    expect(result.primary_key).toEqual(['id'])
    const byName = Object.fromEntries(result.columns.map((c) => [c.name, c]))
    expect(byName.id?.primary_key).toBe(true)
    expect(byName.team_id?.primary_key).toBeUndefined()
    expect(byName.team_id?.references).toEqual({
      schema: 'public',
      table: 'teams',
      column: 'id',
    })
    expect(byName.email?.references).toBeUndefined()
  })

  it('returns kind=view with empty pk for views', async () => {
    vi.mocked(client.fetchColumns).mockResolvedValue([
      { name: 'team', type: 'text', nullable: true },
    ])
    vi.mocked(client.fetchPrimaryKey).mockResolvedValue([])
    vi.mocked(client.fetchForeignKeys).mockResolvedValue([])
    vi.mocked(client.fetchIndexes).mockResolvedValue([])
    vi.mocked(client.estimatedRowCount).mockResolvedValue(0)
    vi.mocked(client.tableSizeBytes).mockResolvedValue(0)

    const result = await buildEntitySchemaJson(makeAccessor(), 'public', 'user_summary', 'view')
    expect(result.kind).toBe('view')
    expect(result.primary_key).toEqual([])
    expect(result.columns[0]).toEqual({ name: 'team', type: 'text', nullable: true })
  })

  it('maps multi-column FK columns to references one-to-one', async () => {
    vi.mocked(client.fetchColumns).mockResolvedValue([
      { name: 'tenant_id', type: 'uuid', nullable: false },
      { name: 'user_id', type: 'uuid', nullable: false },
    ])
    vi.mocked(client.fetchPrimaryKey).mockResolvedValue(['tenant_id', 'user_id'])
    vi.mocked(client.fetchForeignKeys).mockResolvedValue([
      {
        columns: ['tenant_id', 'user_id'],
        references: {
          schema: 'public',
          table: 'accounts',
          columns: ['tenant_id', 'id'],
        },
      },
    ])
    vi.mocked(client.fetchIndexes).mockResolvedValue([])
    vi.mocked(client.estimatedRowCount).mockResolvedValue(0)
    vi.mocked(client.tableSizeBytes).mockResolvedValue(0)

    const result = await buildEntitySchemaJson(makeAccessor(), 'public', 'memberships', 'table')
    const byName = Object.fromEntries(result.columns.map((c) => [c.name, c]))
    expect(byName.tenant_id?.references).toEqual({
      schema: 'public',
      table: 'accounts',
      column: 'tenant_id',
    })
    expect(byName.user_id?.references).toEqual({
      schema: 'public',
      table: 'accounts',
      column: 'id',
    })
  })
})

describe('databaseNameFromDsn', () => {
  it('extracts plain database name', () => {
    expect(databaseNameFromDsn('postgres://localhost/acme_prod')).toBe('acme_prod')
  })

  it('strips query string', () => {
    expect(databaseNameFromDsn('postgres://localhost/acme?sslmode=require')).toBe('acme')
  })

  it('handles user/pass/port', () => {
    expect(databaseNameFromDsn('postgres://u:p@db.example.com:5432/myapp')).toBe('myapp')
  })

  it('falls back to host segment when no db path', () => {
    expect(databaseNameFromDsn('postgres://localhost')).toBe('localhost')
  })
})
