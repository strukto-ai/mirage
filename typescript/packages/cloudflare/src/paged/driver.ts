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
import type { DurableObjectStorageLike } from '../sql.ts'
import { PagedDatabase } from './database.ts'

// A turn of the event loop is due after this many statements, or sooner once
// the statements since the last turn carried this many bytes of BLOBs, and
// after every statement once a stretch between two turns took this long.
const TURN_STATEMENTS = 50
const TURN_BLOB_BYTES = 65536
const SLOW_STRETCH_MS = 300

/** How a paged driver is opened. */
export interface PagedSqlOptions {
  /** The SQLite build to run, for a bundler that cannot import the packaged one. */
  readonly wasm?: WebAssembly.Module
  /** The most bytes of the storage's rows kept in memory; 8 MB when unset. */
  readonly cacheBytes?: number
  /** The most bytes of changed pages held before some are written ahead; 6 MB when unset. */
  readonly spillBytes?: number
  /** The most bytes of pages SQLite itself keeps in memory; 2 MB when unset. */
  readonly pageCacheBytes?: number
}

// The storages a driver is open on: two would each write rows the other
// knows nothing of.
const opened = new WeakSet<DurableObjectStorageLike>()

// One location a storage, as `DurableObjectSqlDriver` labels its own: the
// database inside is not the storage's, so it takes another name.
const labels = new WeakMap<DurableObjectStorageLike, string>()
let labelled = 0
function labelOf(storage: DurableObjectStorageLike): string {
  let label = labels.get(storage)
  if (label === undefined) {
    label = `durable-object-paged#${String(++labelled)}`
    labels.set(storage, label)
  }
  return label
}

/**
 * A SQLite database of its own inside a Durable Object's storage, as the sql
 * mount's driver.
 *
 * A Durable Object bills every row its SQLite writes, and a mount on
 * `DurableObjectSqlDriver` writes a row a file chunk, a name and a record.
 * This driver keeps the mount's tables in a database inside, whose changed
 * pages reach the storage as a few large rows: a command that wrote
 * thousands of rows costs one or two.
 *
 * What statements change stays in memory until `flush`, so a host calls it
 * before it answers a request; `close` flushes too. A flush is whole or
 * absent, and an object that stops before one loses what it had not flushed.
 * One driver holds a storage at a time: an object opens its own once and
 * keeps it, and `close` lets another be opened.
 *
 * The driver is a `DurableObjectStorageLike` as well: `sql.exec` and
 * `transactionSync` run in the database inside, for tables of the host's own.
 */
export class DurableObjectPagedSqlDriver implements SqlDriver, DurableObjectStorageLike {
  readonly dialect = SqlDialect.SQLITE
  readonly exclusive = true
  readonly sql = {
    exec: (
      query: string,
      ...bindings: unknown[]
    ): { toArray(): SqlRow[]; [Symbol.iterator](): IterableIterator<SqlRow> } => {
      const rows = this.database.exec(query, bindings)
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }
    },
  }
  private statements = 0
  private budget = TURN_STATEMENTS
  private blobBytes = 0
  private turned = Date.now()
  private turning: Promise<void> | null = null

  private constructor(
    private readonly database: PagedDatabase,
    private readonly storage: DurableObjectStorageLike,
    readonly location: string,
  ) {}

  /**
   * Open the database a Durable Object's storage holds, made when it holds none.
   *
   * @param storage the object's `ctx.storage`.
   * @param options the SQLite build and the memory the driver may hold.
   * @throws when a driver is open on `storage` already.
   */
  static async open(
    storage: DurableObjectStorageLike,
    options: PagedSqlOptions = {},
  ): Promise<DurableObjectPagedSqlDriver> {
    if (opened.has(storage)) {
      throw new Error('a paged sql driver is already open on this storage: close it first')
    }
    opened.add(storage)
    try {
      const wasm = options.wasm ?? (await import('./wasm.ts')).default
      const database = await PagedDatabase.open(storage, wasm, options)
      return new DurableObjectPagedSqlDriver(database, storage, labelOf(storage))
    } catch (e) {
      opened.delete(storage)
      throw e
    }
  }

  query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const rows = this.database.exec(sql, params)
    return this.due(1) ? this.turn().then(() => rows) : Promise.resolve(rows)
  }

  batch(statements: readonly SqlStatement[]): Promise<void> {
    this.transactionSync(() => {
      for (const s of statements) this.database.exec(s.sql, s.params ?? [])
    })
    return this.due(statements.length) ? this.turn() : Promise.resolve()
  }

  transactionSync<T>(fn: () => T): T {
    this.database.exec('BEGIN')
    try {
      const out = fn()
      this.database.exec('COMMIT')
      return out
    } catch (e) {
      this.database.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * Commit what statements changed to the object's storage, all of it or none.
   *
   * @returns the rows the storage was billed for.
   */
  flush(): number {
    return this.database.flush()
  }

  close(): Promise<void> {
    try {
      this.database.close()
    } finally {
      opened.delete(this.storage)
    }
    return Promise.resolve()
  }

  private due(statements: number): boolean {
    this.statements += statements
    return (
      this.turning !== null ||
      this.statements >= this.budget ||
      this.database.blobBytes - this.blobBytes >= TURN_BLOB_BYTES
    )
  }

  // Every statement answers at once, so a long command would never let the
  // object's event loop turn, and an object whose storage waits too long on
  // a busy loop is reset. So an answer waits a turn now and then. A Worker's
  // clock stands still while it computes, so how long a stretch took is known
  // only once a turn ends it: the wait follows the work done instead, and a
  // stretch that did take long makes every statement wait. Statements issued
  // while a turn is awaited share it.
  private turn(): Promise<void> {
    this.turning ??= new Promise<void>((resolve) => {
      setTimeout(() => {
        const now = Date.now()
        const took = now - this.turned
        if (took > SLOW_STRETCH_MS) this.budget = 1
        else if (took * 4 < SLOW_STRETCH_MS) {
          this.budget = Math.min(TURN_STATEMENTS, this.budget * 2)
        }
        this.turned = now
        this.statements = 0
        this.blobBytes = this.database.blobBytes
        this.turning = null
        resolve()
      }, 0)
    })
    return this.turning
  }
}
