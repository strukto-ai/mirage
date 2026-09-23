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

import { MountMode } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Workspace } from '../../workspace.ts'
import { PostgresVFS } from './postgres.ts'

// vitest 4 types a bare `vi.fn()` as neither callable nor constructable.
type AnyMock = Mock<(...args: never[]) => unknown>

interface MockPool {
  query: AnyMock
  end: AnyMock
}

const pools: MockPool[] = []
const PoolCtor = vi.fn(function () {
  const pool: MockPool = {
    query: vi.fn((sql: string, params?: unknown[]) => Promise.resolve(handleQuery(sql, params))),
    end: vi.fn(() => Promise.resolve()),
  }
  pools.push(pool)
  return pool
})

vi.mock('pg', () => ({
  default: { Pool: PoolCtor },
  Pool: PoolCtor,
}))

let largeRows = 5
let largeWidth = 64

function handleQuery(sql: string, params?: unknown[]): { rows: unknown[]; rowCount: number } {
  if (sql.includes('information_schema.schemata')) {
    return ok([{ schema_name: 'public' }])
  }
  if (sql.includes("table_type = 'BASE TABLE'")) {
    return ok([{ table_name: 'users' }])
  }
  if (sql.includes('information_schema.views')) {
    return ok([])
  }
  if (sql.includes('pg_matviews')) {
    return ok([])
  }
  if (sql.startsWith('SELECT reltuples')) {
    return ok([{ reltuples: 5 }])
  }
  if (sql.startsWith('SELECT pg_total_relation_size')) {
    return ok([{ size: 4096 }])
  }
  if (sql.includes('pg_constraint') && sql.includes('ANY($1::text[])')) {
    return ok([])
  }
  if (sql.includes('pg_constraint')) {
    return ok([])
  }
  if (sql.includes('information_schema.columns') && sql.includes('table_name = $2')) {
    return ok([
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'name', data_type: 'text', is_nullable: 'YES' },
    ])
  }
  if (sql.includes('information_schema.table_constraints')) {
    return ok([{ column_name: 'id' }])
  }
  if (sql.includes('FROM pg_class t')) {
    return ok([])
  }
  if (sql.startsWith('EXPLAIN (FORMAT JSON)')) {
    return ok([{ 'QUERY PLAN': [{ Plan: { 'Plan Rows': largeRows, 'Plan Width': largeWidth } }] }])
  }
  if (sql.startsWith('SELECT COUNT(*)')) {
    return ok([{ count: 5 }])
  }
  if (sql.startsWith('SELECT * FROM "public"."users" LIMIT')) {
    const limit = (params?.[0] as number | undefined) ?? 5
    const offset = (params?.[1] as number | undefined) ?? 0
    const rows = Array.from({ length: Math.min(limit, 5 - offset) }, (_, i) => ({
      id: String(offset + i + 1),
      name: `user_${String(offset + i + 1)}`,
    }))
    return ok(rows)
  }
  if (sql.startsWith('SELECT current_database()')) {
    return ok([{ db: 'acme' }])
  }
  return ok([])
}

function ok(rows: unknown[]): { rows: unknown[]; rowCount: number } {
  return { rows, rowCount: rows.length }
}

describe('PostgresVFS mount integration', () => {
  let ws: Workspace
  let vfs: PostgresVFS

  beforeEach(() => {
    pools.length = 0
    PoolCtor.mockClear()
    largeRows = 5
    largeWidth = 64
    vfs = new PostgresVFS({ dsn: 'postgres://localhost/acme' })
    ws = new Workspace({ '/pg': vfs }, { mode: MountMode.READ })
  })

  afterEach(async () => {
    await ws.close()
  })

  it('readdir /pg returns database.json + schemas', async () => {
    const r = await ws.shell('ls /pg')
    const stdout = new TextDecoder().decode(r.stdout)
    expect(stdout).toContain('database.json')
    expect(stdout).toContain('public')
  })

  it('cat /pg/database.json returns the synthetic JSON shape', async () => {
    const r = await ws.shell('cat /pg/database.json')
    const doc = JSON.parse(new TextDecoder().decode(r.stdout)) as {
      database: string
      schemas: string[]
      tables: {
        schema: string
        name: string
        row_count_estimate: number
        size_bytes_estimate: number
      }[]
      relationships: unknown[]
    }
    expect(doc.database).toBe('acme')
    expect(doc.schemas).toEqual(['public'])
    expect(doc.tables).toHaveLength(1)
    expect(doc.tables[0]).toMatchObject({
      schema: 'public',
      name: 'users',
      row_count_estimate: 5,
      size_bytes_estimate: 4096,
    })
    expect(doc.relationships).toEqual([])
  })

  it('cat /pg/public/tables/users/schema.json returns column metadata', async () => {
    const r = await ws.shell('cat /pg/public/tables/users/schema.json')
    const doc = JSON.parse(new TextDecoder().decode(r.stdout)) as {
      kind: string
      name: string
      primary_key: string[]
      columns: { name: string; primary_key?: boolean; nullable?: boolean }[]
    }
    expect(doc.kind).toBe('table')
    expect(doc.name).toBe('users')
    expect(doc.primary_key).toEqual(['id'])
    const byName = Object.fromEntries(doc.columns.map((c) => [c.name, c]))
    expect(byName.id?.primary_key).toBe(true)
    expect(byName.name?.nullable).toBe(true)
  })

  it('cat /pg/public/tables/users/rows.jsonl returns JSONL when small', async () => {
    const r = await ws.shell('cat /pg/public/tables/users/rows.jsonl')
    const text = new TextDecoder().decode(r.stdout)
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(5)
    expect(JSON.parse(lines[0] ?? '')).toEqual({ id: '1', name: 'user_1' })
  })

  it('cat surfaces size guard as exit_code=1 + stderr when table is large', async () => {
    largeRows = 50_000
    largeWidth = 100
    const r = await ws.shell('cat /pg/public/tables/users/rows.jsonl')
    expect(r.exitCode).toBe(1)
    expect(new TextDecoder().decode(r.stderr)).toContain('too large to read entirely')
  })

  it('head -n 2 pushes down to fetchRows and bypasses guard', async () => {
    largeRows = 50_000
    largeWidth = 100
    const r = await ws.shell('head -n 2 /pg/public/tables/users/rows.jsonl')
    const lines = new TextDecoder().decode(r.stdout).trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ id: '1' })
  })

  it('wc -l on rows.jsonl pushes down to COUNT(*)', async () => {
    const r = await ws.shell('wc -l /pg/public/tables/users/rows.jsonl')
    expect(new TextDecoder().decode(r.stdout).trim()).toBe('5 /pg/public/tables/users/rows.jsonl')
  })
})
