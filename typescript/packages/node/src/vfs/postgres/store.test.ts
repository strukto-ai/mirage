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

import { resolvePostgresConfig } from '@struktoai/mirage-core/vfs/postgres/config'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { PostgresStore } from './store.ts'

// vitest 4 types a bare `vi.fn()` as neither callable nor constructable.
type AnyMock = Mock<(...args: never[]) => unknown>

interface MockPool {
  query: AnyMock
  end: AnyMock
  options: Record<string, unknown>
}

const pools: MockPool[] = []
const PoolCtor = vi.fn(function (options: Record<string, unknown>) {
  const pool: MockPool = {
    options,
    query: vi.fn((_sql: string, _params?: unknown[]) =>
      Promise.resolve({ rows: [{ x: 1 }], rowCount: 1 }),
    ),
    end: vi.fn(() => Promise.resolve()),
  }
  pools.push(pool)
  return pool
})

vi.mock('pg', () => ({
  default: { Pool: PoolCtor },
  Pool: PoolCtor,
}))

describe('PostgresStore', () => {
  beforeEach(() => {
    pools.length = 0
    PoolCtor.mockClear()
  })

  afterEach(async () => {
    await Promise.all(pools.map((p) => p.end() as Promise<void>))
  })

  it('does not create a pool until first query', () => {
    const store = new PostgresStore(resolvePostgresConfig({ dsn: 'postgres://localhost/db' }))
    void store
    expect(PoolCtor).not.toHaveBeenCalled()
  })

  it('lazily creates a single pool with read-only server option', async () => {
    const store = new PostgresStore(resolvePostgresConfig({ dsn: 'postgres://localhost/db' }))
    await store.query('SELECT 1')
    await store.query('SELECT 2')
    expect(PoolCtor).toHaveBeenCalledTimes(1)
    const opts = PoolCtor.mock.calls[0]?.[0]
    expect(opts?.connectionString).toBe('postgres://localhost/db')
    expect(opts?.options).toBe('-c default_transaction_read_only=on')
  })

  it('forwards SQL and params to pg.Pool.query', async () => {
    const store = new PostgresStore(resolvePostgresConfig({ dsn: 'postgres://localhost/db' }))
    const result = await store.query('SELECT $1::int AS x', [42])
    expect(result.rows).toEqual([{ x: 1 }])
    expect(result.rowCount).toBe(1)
    expect(pools[0]?.query).toHaveBeenCalledWith('SELECT $1::int AS x', [42])
  })

  it('calls end() on close and resets the pool', async () => {
    const store = new PostgresStore(resolvePostgresConfig({ dsn: 'postgres://localhost/db' }))
    await store.query('SELECT 1')
    await store.close()
    expect(pools[0]?.end).toHaveBeenCalledTimes(1)
    await store.query('SELECT 2')
    expect(PoolCtor).toHaveBeenCalledTimes(2)
  })

  it('databaseName() returns current_database()', async () => {
    const store = new PostgresStore(resolvePostgresConfig({ dsn: 'postgres://localhost/acme' }))
    pools.length = 0
    PoolCtor.mockClear()
    PoolCtor.mockImplementationOnce(function (options: Record<string, unknown>) {
      const pool: MockPool = {
        options,
        query: vi.fn(() => Promise.resolve({ rows: [{ db: 'acme' }], rowCount: 1 })),
        end: vi.fn(() => Promise.resolve()),
      }
      pools.push(pool)
      return pool
    })
    const name = await store.databaseName()
    expect(name).toBe('acme')
    expect(pools[0]?.query).toHaveBeenCalledWith('SELECT current_database() AS db', undefined)
  })
})
