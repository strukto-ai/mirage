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

import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite'
import type { Dmmf, DmmfField } from './seed.ts'

// A fake's request path over node:sqlite rather than its Prisma client. Prisma
// sends every query through its engine as JSON and decodes the rows back,
// about 110us a read where SQLite itself takes 5; the run's file is the same,
// so seeding, resets and the schema stay with Prisma, which runs them once.
const STATEMENTS = new WeakMap<DatabaseSync, Map<string, StatementSync>>()
const RUNS = new WeakMap<DatabaseSync, number>()

/**
 * How many statements the helpers here have run on `db`, for a selftest that
 * bounds how many queries a lookup costs.
 */
export function statementsRun(db: DatabaseSync): number {
  return RUNS.get(db) ?? 0
}

/** The prepared statement for `sql` on `db`, compiled once per connection. */
export function stmt(db: DatabaseSync, sql: string): StatementSync {
  RUNS.set(db, (RUNS.get(db) ?? 0) + 1)
  let cache = STATEMENTS.get(db)
  if (cache === undefined) {
    cache = new Map()
    STATEMENTS.set(db, cache)
  }
  let made = cache.get(sql)
  if (made === undefined) {
    made = db.prepare(sql)
    cache.set(sql, made)
  }
  return made
}

/** The first row `sql` returns, or null. */
export function one<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | null {
  return (stmt(db, sql).get(...params) as T | undefined) ?? null
}

/** Every row `sql` returns. */
export function all<T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] {
  return stmt(db, sql).all(...params) as T[]
}

/**
 * Run a statement that returns no rows, answering how many rows it changed.
 * Prisma's update and delete threw when that was none, and a store that keeps
 * the throw checks this.
 */
export function exec(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  return Number(stmt(db, sql).run(...params).changes)
}

// node:sqlite binds an empty Uint8Array as NULL when nothing backs it, as is
// true of one read back from SQLite or cut from an empty ArrayBuffer, where
// Prisma stored an empty BLOB. A Bytes value is therefore written as BYTES
// with the two parameters `bytes(value)` gives, so an empty value stays an
// empty BLOB and only null is NULL.
export const BYTES = "CASE WHEN ? THEN X'' ELSE ? END"

/** The two parameters BYTES takes for `value`. */
export function bytes(value: Uint8Array | null): [number, Uint8Array | null] {
  return [value !== null && value.length === 0 ? 1 : 0, value]
}

/** A column value as a write takes it: a boolean is stored as 0 or 1. */
export type Cell = SQLInputValue | boolean | undefined

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

interface Shape {
  head: string
  texts: string[]
  flags: string[]
  wide: string[]
}

const SHAPES = new WeakMap<Dmmf, Map<string, Shape>>()

function columnOf(field: DmmfField): string {
  return field.dbName ?? field.name
}

// The SELECT list for one model, worked out once per schema.
function shapeOf(dmmf: Dmmf, model: string): Shape {
  let byModel = SHAPES.get(dmmf)
  if (byModel === undefined) {
    byModel = new Map()
    SHAPES.set(dmmf, byModel)
  }
  const known = byModel.get(model)
  if (known !== undefined) return known
  const def = dmmf.datamodel.models.find((m) => m.name === model)
  if (def === undefined) throw new Error(`kit sql: no model ${model} in the schema`)
  const fields = def.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum')
  const columns = fields.map((f) => {
    const name = quoted(columnOf(f))
    if (f.type === 'String') return `CAST(${name} AS BLOB) AS ${name}`
    if (f.type === 'BigInt') return `CAST(${name} AS TEXT) AS ${name}`
    return name
  })
  const shape = {
    head: `SELECT ${columns.join(', ')} FROM ${quoted(def.dbName ?? def.name)}`,
    texts: fields.filter((f) => f.type === 'String').map(columnOf),
    flags: fields.filter((f) => f.type === 'Boolean').map(columnOf),
    wide: fields.filter((f) => f.type === 'BigInt').map(columnOf),
  }
  byModel.set(model, shape)
  return shape
}

const UTF8 = new TextDecoder()

/**
 * The rows of `model` that `where` (the SQL after WHERE, with `?` marks)
 * selects, every scalar column as Prisma's findMany returned it: a Boolean
 * back from 0 or 1 and a BigInt parsed from its text, since a snowflake
 * passes 2^53. A String is read as its bytes and decoded, because node:sqlite
 * ends a TEXT value at its first NUL.
 */
export function select<T>(
  db: DatabaseSync,
  dmmf: Dmmf,
  model: string,
  where: string,
  ...params: Exclude<Cell, undefined>[]
): T[] {
  const shape = shapeOf(dmmf, model)
  const rows = all<Record<string, SQLOutputValue | boolean | bigint>>(
    db,
    `${shape.head} WHERE ${where}`,
    ...params.map(bound),
  )
  for (const row of rows) {
    for (const name of shape.texts) {
      const value = row[name]
      if (value instanceof Uint8Array) row[name] = UTF8.decode(value)
    }
    for (const name of shape.flags) if (row[name] !== null) row[name] = row[name] !== 0
    for (const name of shape.wide) {
      const value = row[name]
      if (typeof value === 'string') row[name] = BigInt(value)
    }
  }
  return rows as unknown as T[]
}

/** How many rows of `table` `where` selects. */
export function count(
  db: DatabaseSync,
  table: string,
  where: string,
  ...params: Exclude<Cell, undefined>[]
): number {
  const found = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM ${quoted(table)} WHERE ${where}`,
    ...params.map(bound),
  )
  return found?.n ?? 0
}

/** Delete the rows of `table` whose columns equal `where`, answering how many went. */
export function remove(
  db: DatabaseSync,
  table: string,
  where: Readonly<Record<string, Exclude<Cell, undefined>>>,
): number {
  const terms = Object.keys(where).map((name) => `${quoted(name)} = ?`)
  return exec(
    db,
    `DELETE FROM ${quoted(table)} WHERE ${terms.join(' AND ')}`,
    ...Object.values(where).map(bound),
  )
}

/**
 * Throw unless a write changed a row, as Prisma's update and delete threw when
 * their row was missing.
 */
export function matched(changed: number): void {
  if (changed === 0) throw new Error('kit sql: no row matched the write')
}

/** The first row `select` would answer, or null. */
export function first<T>(
  db: DatabaseSync,
  dmmf: Dmmf,
  model: string,
  where: string,
  ...params: Exclude<Cell, undefined>[]
): T | null {
  return select<T>(db, dmmf, model, `${where} LIMIT 1`, ...params)[0] ?? null
}

// A plain parameter as SQLite takes it.
function bound(value: Exclude<Cell, undefined>): SQLInputValue {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value
}

// The placeholder a value takes (BYTES for bytes) and what it binds.
function placed(value: Exclude<Cell, undefined>): [string, SQLInputValue[]] {
  if (value instanceof Uint8Array) return [BYTES, bytes(value)]
  if (typeof value === 'boolean') return ['?', [value ? 1 : 0]]
  return ['?', [value]]
}

/**
 * Insert `row` into `table`, a column per key, answering its rowid. A key left
 * undefined takes the schema's default, as Prisma's create left it.
 */
export function insert(
  db: DatabaseSync,
  table: string,
  row: Readonly<Record<string, Cell>>,
): number {
  const columns: string[] = []
  const marks: string[] = []
  const params: SQLInputValue[] = []
  for (const [name, value] of Object.entries(row)) {
    if (value === undefined) continue
    const [mark, bound] = placed(value)
    columns.push(quoted(name))
    marks.push(mark)
    params.push(...bound)
  }
  const done = stmt(
    db,
    `INSERT INTO ${quoted(table)} (${columns.join(', ')}) VALUES (${marks.join(', ')})`,
  ).run(...params)
  return Number(done.lastInsertRowid)
}

/**
 * Insert `row` into `model`'s table and read it back whole, defaults filled
 * in, as Prisma's create answered it.
 */
export function create<T>(
  db: DatabaseSync,
  dmmf: Dmmf,
  model: string,
  row: Readonly<Record<string, Cell>>,
): T {
  const rowid = insert(db, model, row)
  const made = first<T>(db, dmmf, model, 'rowid = ?', rowid)
  if (made === null) throw new Error(`kit sql: a ${model} row vanished as it was written`)
  return made
}

/**
 * Set the columns `set` names on the rows of `table` whose columns equal
 * `where`, answering how many rows changed. A key left undefined is left
 * alone, as Prisma's update and updateMany left it.
 */
export function update(
  db: DatabaseSync,
  table: string,
  set: Readonly<Record<string, Cell>>,
  where: Readonly<Record<string, Exclude<Cell, undefined>>>,
): number {
  const sets: string[] = []
  const params: SQLInputValue[] = []
  for (const [name, value] of Object.entries(set)) {
    if (value === undefined) continue
    const [mark, bound] = placed(value)
    sets.push(`${quoted(name)} = ${mark}`)
    params.push(...bound)
  }
  const terms: string[] = []
  for (const [name, value] of Object.entries(where)) {
    const [mark, bound] = placed(value)
    terms.push(`${quoted(name)} = ${mark}`)
    params.push(...bound)
  }
  // With nothing to set, a no-op assignment still counts the rows matched, as
  // Prisma's update with empty data still found (or missed) its row.
  if (sets.length === 0) {
    const first = quoted(Object.keys(where)[0] ?? 'tenant')
    sets.push(`${first} = ${first}`)
  }
  return exec(
    db,
    `UPDATE ${quoted(table)} SET ${sets.join(', ')} WHERE ${terms.join(' AND ')}`,
    ...params,
  )
}
