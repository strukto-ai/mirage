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

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { DurableObjectStorageLike } from '../src/sql.ts'

/** The SQLite build the paged driver runs, compiled as a Worker's bundler would. */
export function sqliteWasm(): WebAssembly.Module {
  const path = createRequire(import.meta.url).resolve('wa-sqlite/dist/wa-sqlite.wasm')
  return new WebAssembly.Module(readFileSync(path))
}

/**
 * A Durable Object's storage over a SQLite database in memory.
 *
 * It counts the rows written, as the object is billed, and can refuse a
 * write the way a storage that fails mid-commit does.
 */
export class ObjectStorage implements DurableObjectStorageLike {
  /** The rows inserted, updated and deleted so far. */
  rowsWritten = 0
  /** The writes left before one throws; none throws while it is null. */
  writesLeft: number | null = null
  private readonly db = new DatabaseSync(':memory:')

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } => {
      const statement = this.db.prepare(query)
      const values = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SQLInputValue),
      )
      if (!/^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)) {
        const rows = statement.all(...values) as Record<string, unknown>[]
        return { toArray: () => rows }
      }
      if (this.writesLeft !== null && this.writesLeft-- <= 0) {
        throw new Error('the storage refused a write')
      }
      this.rowsWritten += Number(statement.run(...values).changes)
      return { toArray: () => [] }
    },
  }

  transactionSync<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}
