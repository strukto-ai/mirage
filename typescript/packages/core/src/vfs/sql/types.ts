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

/** A value one SQL parameter or column carries. */
export type SqlValue = string | number | bigint | Uint8Array | null

/** One row a query answers, by column name. */
export type SqlRow = Record<string, SqlValue>

/** One statement and its positional `?` parameters. */
export interface SqlStatement {
  readonly sql: string
  readonly params?: readonly SqlValue[]
}

/**
 * The SQL a database speaks where databases part: the column types its tables
 * are made with, and how a statement names the inode the one before it made.
 * Every other statement the sql ops run is plain SQL every dialect reads.
 * Mirrors Python's `SqlDialect`.
 */
export const SqlDialect = Object.freeze({
  SQLITE: 'sqlite',
  POSTGRES: 'postgres',
})

export type SqlDialect = (typeof SqlDialect)[keyof typeof SqlDialect]

/**
 * A database as the sql ops reach it.
 *
 * Every op reaches its database through this surface and nothing else, so the
 * host is the driver's business: node opens a SQLite file with `node:sqlite`
 * or a Postgres server with `pg`, a Durable Object hands its `ctx.storage.sql`,
 * a Worker its D1 binding, and the ops cannot tell which. Statements number
 * their parameters `?`; a driver whose database numbers them otherwise
 * (`$1` in Postgres) renumbers them. A BLOB column comes back as a
 * `Uint8Array`. Mirrors Python's `SqlDriver`.
 */
export interface SqlDriver {
  /** Where the database lives, for `storageLocation` and `df`. */
  readonly location: string
  readonly dialect: SqlDialect
  /** The rows one statement answers. */
  query(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>
  /** Run every statement in one transaction: all of them land or none. */
  batch(statements: readonly SqlStatement[]): Promise<void>
  close(): Promise<void>
}
