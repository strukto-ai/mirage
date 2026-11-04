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
import { resolve } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

// Each `:memory:` database is its own, so each driver on one gets a location
// of its own.
let memories = 0

/**
 * A SQLite file opened with `node:sqlite`, as the sql mount's driver.
 *
 * The file opens on the first statement, so building a mount never touches
 * the disk; calls that arrive before it has opened share the one opening.
 * `:memory:` holds the database in this driver alone. `location` is the
 * file's absolute path, so two names of one file read as one database, or
 * `:memory:#n`, one per driver. Mirrors Python's `SqliteDriver`.
 */
export class SqliteDriver implements SqlDriver {
  readonly location: string
  readonly dialect = SqlDialect.SQLITE
  private db: Promise<DatabaseSync> | null = null

  constructor(readonly path = ':memory:') {
    this.location = path === ':memory:' ? `:memory:#${String(++memories)}` : resolve(path)
  }

  private open(): Promise<DatabaseSync> {
    this.db ??= import('node:sqlite').then(({ DatabaseSync }) => new DatabaseSync(this.path))
    return this.db
  }

  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const db = await this.open()
    return db.prepare(sql).all(...(params as SQLInputValue[])) as SqlRow[]
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    const db = await this.open()
    db.exec('BEGIN')
    try {
      for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {
    const db = this.db
    this.db = null
    ;(await db)?.close()
  }
}
