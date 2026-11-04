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

import {
  SqlDialect,
  type SqlDriver,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from '@struktoai/mirage-core/vfs/sql/types'
import { missingPeer } from '@struktoai/mirage-core/utils/optional_peer'

interface PgClientLike {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  release(): void
}

interface PgPoolLike {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>
  connect(): Promise<PgClientLike>
  end(): Promise<void>
  on(event: 'error', listener: () => void): void
}

interface PgModule {
  Pool: new (options: Record<string, unknown>) => PgPoolLike
}

// The statements number their parameters `?`; Postgres numbers them `$1`,
// `$2`. No statement the sql ops run holds a `?` in a literal.
function numbered(sql: string): string {
  let n = 0
  return sql.replace(/\?/g, () => `$${String(++n)}`)
}

// pg binds a Buffer as BYTEA and would stringify a bare Uint8Array.
function bind(value: SqlValue): unknown {
  return value instanceof Uint8Array
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value
}

/**
 * A Postgres database reached with `pg`, as the sql mount's driver.
 *
 * The pool opens on the first statement, and a batch holds one of its
 * connections for its `BEGIN` to `COMMIT`. `location` is the server and
 * database without the credentials. Mirrors the shape of `SqliteDriver`.
 */
export class PostgresSqlDriver implements SqlDriver {
  readonly location: string
  readonly dialect = SqlDialect.POSTGRES
  private pool: Promise<PgPoolLike> | null = null

  constructor(private readonly dsn: string) {
    const url = new URL(dsn)
    this.location = `${url.protocol}//${url.host}${url.pathname}`
  }

  private open(): Promise<PgPoolLike> {
    this.pool ??= (async () => {
      const mod = (await import('pg').catch(
        missingPeer({ feature: 'PostgresSqlDriver', packageName: 'pg' }),
      )) as unknown as { default?: PgModule } & Partial<PgModule>
      const Pool = mod.default?.Pool ?? mod.Pool
      if (Pool === undefined) throw new Error('postgres: pg package missing Pool export')
      const pool = new Pool({ connectionString: this.dsn })
      // An idle connection the server dropped is already discarded; the
      // listener keeps Node from ending the process over it.
      pool.on('error', () => undefined)
      return pool
    })()
    return this.pool
  }

  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const pool = await this.open()
    return (await pool.query(numbered(sql), params.map(bind))).rows as SqlRow[]
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    const client = await (await this.open()).connect()
    try {
      await client.query('BEGIN')
      try {
        for (const s of statements) await client.query(numbered(s.sql), (s.params ?? []).map(bind))
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    if (this.pool === null) return
    const pool = await this.pool
    this.pool = null
    await pool.end()
  }
}
