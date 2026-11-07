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

import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { SqlDialect, type SqlDriver, type SqlRow } from '../../../src/vfs/sql/types.ts'

/** A connection of its own to one SQLite file, as a process on it holds one. */
export function fileDriver(path: string): SqlDriver {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA busy_timeout = 5000')
  return {
    location: path,
    dialect: SqlDialect.SQLITE,
    query: (sql, params = []) =>
      Promise.resolve(db.prepare(sql).all(...(params as SQLInputValue[])) as SqlRow[]),
    batch: (statements) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const s of statements) db.prepare(s.sql).run(...((s.params ?? []) as SQLInputValue[]))
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      return Promise.resolve()
    },
    close: () => {
      db.close()
      return Promise.resolve()
    },
  }
}
