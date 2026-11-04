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

/** What a Durable Object's `ctx.storage` offers the driver: its SQLite and a sync transaction. */
export interface DurableObjectStorageLike {
  readonly sql: {
    exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] }
  }
  transactionSync<T>(fn: () => T): T
}

interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike
  all(): Promise<{ results: Record<string, unknown>[] }>
}

/** What a D1 binding offers the driver: prepared statements and a batch. */
export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike
  batch(statements: D1StatementLike[]): Promise<unknown[]>
}

// A database's default location: one per database object, so two drivers on
// one binding read as one database and two bindings as two.
const labels = new WeakMap<D1DatabaseLike | DurableObjectStorageLike, string>()
let labelled = 0
function labelOf(kind: string, db: D1DatabaseLike | DurableObjectStorageLike): string {
  let label = labels.get(db)
  if (label === undefined) {
    label = `${kind}#${String(++labelled)}`
    labels.set(db, label)
  }
  return label
}

// A BLOB binds as its own ArrayBuffer: both hosts take one, neither a view.
function bind(value: SqlValue): unknown {
  if (!(value instanceof Uint8Array)) return value
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
}

// A BLOB comes back as an ArrayBuffer from a Durable Object and as an array
// of bytes from D1; the ops read a Uint8Array either way.
function row(raw: Record<string, unknown>): SqlRow {
  const out: SqlRow = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value instanceof ArrayBuffer) out[key] = new Uint8Array(value)
    else if (ArrayBuffer.isView(value))
      out[key] = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    else if (Array.isArray(value)) out[key] = Uint8Array.from(value as number[])
    else out[key] = value as SqlValue
  }
  return out
}

/**
 * A Durable Object's own SQLite (`ctx.storage`), as the sql mount's driver.
 *
 * The database is the object's: it outlives the object's memory, so a mount
 * on it keeps its files through hibernation, eviction and restarts. A batch
 * runs in `transactionSync`, all or nothing.
 */
export class DurableObjectSqlDriver implements SqlDriver {
  readonly dialect = SqlDialect.SQLITE

  constructor(
    private readonly storage: DurableObjectStorageLike,
    readonly location = labelOf('durable-object', storage),
  ) {}

  query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    return Promise.resolve(
      this.storage.sql
        .exec(sql, ...params.map(bind))
        .toArray()
        .map(row),
    )
  }

  batch(statements: readonly SqlStatement[]): Promise<void> {
    this.storage.transactionSync(() => {
      for (const s of statements) this.storage.sql.exec(s.sql, ...(s.params ?? []).map(bind))
    })
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** A D1 database, as the sql mount's driver; a batch is one D1 `batch`, all or nothing. */
export class D1SqlDriver implements SqlDriver {
  readonly dialect = SqlDialect.SQLITE

  constructor(
    private readonly db: D1DatabaseLike,
    readonly location = labelOf('d1', db),
  ) {}

  async query(sql: string, params: readonly SqlValue[] = []): Promise<SqlRow[]> {
    const { results } = await this.db
      .prepare(sql)
      .bind(...params.map(bind))
      .all()
    return results.map(row)
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    await this.db.batch(
      statements.map((s) => this.db.prepare(s.sql).bind(...(s.params ?? []).map(bind))),
    )
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
