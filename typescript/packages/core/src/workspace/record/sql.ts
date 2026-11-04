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

import { compareCodePoints } from '../../utils/sort.ts'
import type { SqlDriver } from '../../vfs/sql/types.ts'
import { generationOf, type RecordClient, type RecordFields } from './types.ts'

const SCHEMA = `CREATE TABLE IF NOT EXISTS mirage_records (
  scope TEXT NOT NULL, name TEXT NOT NULL, fields TEXT NOT NULL, generation BIGINT NOT NULL,
  PRIMARY KEY (scope, name))`

/** Every statement the sql record client runs, by name. Mirrors Python's `RECORD_SQL`. */
export const RECORD_SQL = {
  get: 'SELECT fields, generation FROM mirage_records WHERE scope = ? AND name = ?',
  put: 'INSERT INTO mirage_records (scope, name, fields, generation) VALUES (?, ?, ?, ?) ON CONFLICT (scope, name) DO UPDATE SET fields = excluded.fields, generation = excluded.generation',
  insertNew:
    'INSERT INTO mirage_records (scope, name, fields, generation) VALUES (?, ?, ?, ?) ON CONFLICT (scope, name) DO NOTHING RETURNING name',
  updateAt:
    'UPDATE mirage_records SET fields = ?, generation = ? WHERE scope = ? AND name = ? AND generation = ? RETURNING name',
  listNames: 'SELECT name FROM mirage_records WHERE scope = ?',
  delete: 'DELETE FROM mirage_records WHERE scope = ? AND name = ?',
  clear: 'DELETE FROM mirage_records WHERE scope = ?',
} as const

/**
 * A keyed-record client over any `SqlDriver`'s database: one JSON record per
 * name in `mirage_records`, scoped so sessions, the node table and metadata
 * share one table. The generation lives in its own column, so a CAS write is
 * one conditional statement: it lands only when the stored generation still
 * matches, on every host the driver reaches. Mirrors Python's
 * `SqlRecordClient`.
 */
export class SqlRecordClient implements RecordClient {
  private ready: Promise<void> | null = null

  constructor(
    private readonly driver: SqlDriver,
    readonly scope: string,
  ) {}

  // A failed first statement is tried again on the next call, not kept.
  private async db(): Promise<SqlDriver> {
    this.ready ??= this.driver.batch([{ sql: SCHEMA }]).catch((err: unknown) => {
      this.ready = null
      throw err
    })
    await this.ready
    return this.driver
  }

  async get(name: string): Promise<[RecordFields | null, string]> {
    const row = (await (await this.db()).query(RECORD_SQL.get, [this.scope, name]))[0]
    if (row === undefined) return [null, '']
    return [JSON.parse(String(row.fields)) as RecordFields, String(row.generation)]
  }

  async put(name: string, fields: RecordFields): Promise<void> {
    await (
      await this.db()
    ).batch([
      {
        sql: RECORD_SQL.put,
        params: [this.scope, name, JSON.stringify(fields), generationOf(fields)],
      },
    ])
  }

  async casPut(name: string, fields: RecordFields, expectedGeneration: number): Promise<boolean> {
    const db = await this.db()
    const body = JSON.stringify(fields)
    const generation = generationOf(fields)
    const rows =
      expectedGeneration === 0
        ? await db.query(RECORD_SQL.insertNew, [this.scope, name, body, generation])
        : await db.query(RECORD_SQL.updateAt, [
            body,
            generation,
            this.scope,
            name,
            expectedGeneration,
          ])
    if (rows.length > 0 || expectedGeneration !== 0) return rows.length > 0
    const updated = await db.query(RECORD_SQL.updateAt, [body, generation, this.scope, name, 0])
    return updated.length > 0
  }

  async listNames(): Promise<string[]> {
    const rows = await (await this.db()).query(RECORD_SQL.listNames, [this.scope])
    return rows.map((r) => String(r.name)).sort(compareCodePoints)
  }

  async delete(names: readonly string[]): Promise<void> {
    if (names.length === 0) return
    await (
      await this.db()
    ).batch(names.map((name) => ({ sql: RECORD_SQL.delete, params: [this.scope, name] })))
  }

  async clear(): Promise<void> {
    await (await this.db()).batch([{ sql: RECORD_SQL.clear, params: [this.scope] }])
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}
