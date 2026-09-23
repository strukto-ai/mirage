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

import type { PgDriver, PgQueryResult } from '@struktoai/mirage-core/core/postgres/_driver'
import type { PostgresConfigResolved } from '@struktoai/mirage-core/vfs/postgres/config'
import { loadOptionalPeer } from '@struktoai/mirage-core/utils/optional_peer'

interface PgPoolLike {
  query: (
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: unknown[]; rowCount: number | null }>
  end: () => Promise<void>
}

interface PgModule {
  Pool: new (options: Record<string, unknown>) => PgPoolLike
}

export class PostgresStore implements PgDriver {
  readonly config: PostgresConfigResolved
  private poolPromise: Promise<PgPoolLike> | null = null

  constructor(config: PostgresConfigResolved) {
    this.config = config
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<R>> {
    const pool = await this._pool()
    const result = await pool.query(sql, params)
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 }
  }

  async databaseName(): Promise<string> {
    const result = await this.query<{ db: string }>('SELECT current_database() AS db')
    return result.rows[0]?.db ?? ''
  }

  async close(): Promise<void> {
    if (this.poolPromise === null) return
    const pool = await this.poolPromise
    this.poolPromise = null
    await pool.end()
  }

  private async _pool(): Promise<PgPoolLike> {
    this.poolPromise ??= this._connect()
    return this.poolPromise
  }

  protected async _connect(): Promise<PgPoolLike> {
    const mod = await loadOptionalPeer(
      () => import('pg') as unknown as Promise<{ default?: PgModule } & Partial<PgModule>>,
      { feature: 'PostgresVFS', packageName: 'pg' },
    )
    const Pool = mod.default?.Pool ?? mod.Pool
    if (Pool === undefined) {
      throw new Error('postgres: pg package missing Pool export')
    }
    return new Pool({
      connectionString: this.config.dsn,
      options: '-c default_transaction_read_only=on',
    })
  }
}
