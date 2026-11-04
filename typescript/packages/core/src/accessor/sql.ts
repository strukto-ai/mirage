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

import { DEFAULT_CHUNK_SIZE, SCHEMA, SQL } from '../core/sql/constants.ts'
import { systemDate } from '../utils/clock.ts'
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from '../vfs/sql/types.ts'
import { Accessor } from './base.ts'

/**
 * A sql mount's database: its driver, and the tables the ops read, made on
 * the first statement. Mirrors Python's `SqlAccessor`.
 */
export class SqlAccessor extends Accessor {
  readonly driver: SqlDriver
  private opened: Promise<number> | null = null

  constructor(driver: SqlDriver) {
    super()
    this.driver = driver
  }

  /**
   * The bytes one row of a file holds, as the database records it; the
   * tables and the root are made first when the database has none.
   */
  chunkSize(): Promise<number> {
    this.opened ??= this.open().catch((err: unknown) => {
      this.opened = null
      throw err
    })
    return this.opened
  }

  private async open(): Promise<number> {
    const now = Math.floor(systemDate().getTime() / 1000)
    await this.driver.batch([
      ...SCHEMA[this.driver.dialect].map((sql) => ({ sql })),
      { sql: SQL.seedRoot, params: [now] },
    ])
    const row = (await this.driver.query(SQL.chunkSize))[0]
    return Number(row?.value) || DEFAULT_CHUNK_SIZE
  }

  /** The rows one statement answers, once the tables are there. */
  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    await this.chunkSize()
    return this.driver.query(sql, params)
  }

  /** Run `statements` in one transaction, once the tables are there. */
  async batch(statements: readonly SqlStatement[]): Promise<void> {
    if (statements.length === 0) return
    await this.chunkSize()
    await this.driver.batch(statements)
  }
}
