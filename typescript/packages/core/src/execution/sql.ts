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

import { SqlConsoleStore } from '../shell/console/sql.ts'
import {
  SqlDialect,
  type SqlDriver,
  type SqlRow,
  type SqlStatement,
  type SqlValue,
} from '../vfs/sql/types.ts'
import { compareCodePoints } from '../utils/sort.ts'
import { generationOf, type RecordFields } from '../workspace/record/types.ts'
import { ExecutionStore } from './base.ts'
import { HISTORY_MAX_RECORDS, HISTORY_SECONDS } from './constants.ts'
import { LEASE_SECONDS } from './job/constants.ts'
import type { Line } from './line/types.ts'
import type { Process } from './process/types.ts'
import { lineFromFields, lineToFields, processFromFields, processToFields } from './serde.ts'
import { type LineId, ProcessId } from './types.ts'

/** Every statement the sql execution store runs, by name. Mirrors Python's `EXECUTION_SQL`. */
export const EXECUTION_SQL = Object.freeze({
  get: 'SELECT fields, generation, ended FROM mirage_execution WHERE scope = ? AND kind = ? AND name = ?',
  kind: 'SELECT name, fields FROM mirage_execution WHERE scope = ? AND kind = ?',
  put:
    'INSERT INTO mirage_execution (scope, kind, name, fields, generation, ended)' +
    ' VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, kind, name)' +
    ' DO UPDATE SET fields = excluded.fields, generation = excluded.generation, ended = excluded.ended',
  insert_new:
    'INSERT INTO mirage_execution (scope, kind, name, fields, generation, ended)' +
    " VALUES (?, 'list', ?, ?, ?, NULL) ON CONFLICT (scope, kind, name)" +
    ' DO UPDATE SET fields = excluded.fields, generation = excluded.generation' +
    ' WHERE mirage_execution.generation = 0 RETURNING name',
  update_at:
    'UPDATE mirage_execution SET fields = ?, generation = ?' +
    " WHERE scope = ? AND kind = 'list' AND name = ? AND generation = ? RETURNING name",
  delete_at:
    "DELETE FROM mirage_execution WHERE scope = ? AND kind = 'list' AND name = ? AND generation = ?" +
    ' RETURNING fields',
  lease:
    'INSERT INTO mirage_execution (scope, kind, name, fields, generation, ended)' +
    " VALUES (?, 'lease', '', ?, 0, ?) ON CONFLICT (scope, kind, name)" +
    ' DO UPDATE SET fields = excluded.fields, ended = excluded.ended' +
    ' WHERE mirage_execution.fields = excluded.fields OR mirage_execution.ended <= ? RETURNING name',
  add_stop:
    'INSERT INTO mirage_execution (scope, kind, name, fields, generation, ended)' +
    ' VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT (scope, kind, name) DO NOTHING RETURNING name',
  release:
    "DELETE FROM mirage_execution WHERE scope = ? AND kind = 'lease' AND name = '' AND fields = ?",
  raise_pid:
    'INSERT INTO mirage_execution (scope, kind, name, fields, generation, ended)' +
    " VALUES (?, 'pid', '', '{}', ?, NULL) ON CONFLICT (scope, kind, name)" +
    ' DO UPDATE SET generation = excluded.generation' +
    ' WHERE mirage_execution.generation < excluded.generation',
  delete: 'DELETE FROM mirage_execution WHERE scope = ? AND kind = ? AND name = ?',
  delete_kind: 'DELETE FROM mirage_execution WHERE scope = ? AND kind = ?',
  take_kind:
    'DELETE FROM mirage_execution WHERE scope = ? AND kind = ? RETURNING fields, generation',
  prune:
    'DELETE FROM mirage_execution WHERE scope = ? AND kind = ? AND ended IS NOT NULL AND (ended <= ?' +
    ' OR name NOT IN (SELECT name FROM mirage_execution' +
    ' WHERE scope = ? AND kind = ? AND ended IS NOT NULL ORDER BY ended DESC LIMIT ?))',
  drop_console: 'DELETE FROM mirage_console WHERE scope = ? AND name = ?',
  clear: 'DELETE FROM mirage_execution WHERE scope = ?',
  clear_consoles: 'DELETE FROM mirage_console WHERE scope = ?',
} as const)

/** The tables the store keeps its rows in, made on first use; `dialect` names the byte column's type. */
function schema(dialect: SqlDialect): SqlStatement[] {
  const blob = dialect === SqlDialect.POSTGRES ? 'BYTEA' : 'BLOB'
  return [
    {
      sql:
        'CREATE TABLE IF NOT EXISTS mirage_execution (' +
        ' scope TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,' +
        ' fields TEXT NOT NULL, generation BIGINT NOT NULL,' +
        ' ended DOUBLE PRECISION, PRIMARY KEY (scope, kind, name))',
    },
    {
      sql:
        'CREATE TABLE IF NOT EXISTS mirage_console (' +
        ' scope TEXT NOT NULL, name TEXT NOT NULL, seq BIGINT NOT NULL,' +
        ' ts DOUBLE PRECISION NOT NULL, channel TEXT NOT NULL,' +
        ` data ${blob} NOT NULL, PRIMARY KEY (scope, name, seq))`,
    },
  ]
}

/** The consoles a job list names, its disowned jobs' included. */
function consoleNames(fields: RecordFields | null): Set<string> {
  const jobs = (fields?.jobs ?? {}) as Record<string, { console: string }>
  const disowned = (fields?.disowned ?? {}) as Record<string, unknown>
  return new Set([...Object.values(jobs).map((job) => job.console), ...Object.keys(disowned)])
}

/** A record's kind, its row's name and its fields. */
function recordOf(record: Line | Process): [string, string, RecordFields] {
  if (record.id instanceof ProcessId) {
    return ['process', String(record.id.pid), processToFields(record as Process)]
  }
  const line = record as Line
  return ['line', line.id.value, lineToFields(line)]
}

/**
 * ExecutionStore in a SQL database, SQLite or Postgres, shared by every
 * process on it, as rows of two tables it makes on first use:
 *
 * - `mirage_execution`: one row per thing the plane keeps, by kind: a
 *   session's job list (`list`, CAS on its generation column), the
 *   workspace's lease (`lease`, the holder in `fields` and when it lapses in
 *   `ended`), the highest pid (`pid`, in `generation`), the processes a daemon
 *   publishes (`published`), a stop asked of a daemon (`stop:<daemon>`), and
 *   each line and process record (`line`, `process`, with `ended` set once
 *   they end)
 * - `mirage_console`: each job's console, one row per chunk (`SqlConsoleStore`)
 *
 * Every change that two daemons may race on is one conditional statement, so
 * the database settles it. Records are written in the background, in
 * batches, the newest of each winning, and the ended ones are trimmed to the
 * history as they are written; `close` writes what is left. Rows are scoped,
 * so many workspaces share one database. Mirrors Python's
 * `SqlExecutionStore`.
 */
export class SqlExecutionStore extends ExecutionStore {
  private ready: Promise<void> | null = null
  private readonly consoles = new Map<string, SqlConsoleStore>()
  private readonly pending = new Map<string, Line | Process>()
  private inflight = new Map<string, Line | Process>()
  private writing: Promise<void> | null = null

  constructor(
    private readonly driver: SqlDriver,
    private readonly scope = '',
    leaseSeconds: number | null = LEASE_SECONDS,
  ) {
    super(leaseSeconds)
  }

  /**
   * Make the tables once. Two processes making them at once can both find
   * them missing, and Postgres refuses the second, which finds them made when
   * it tries again.
   */
  private schema(): Promise<void> {
    const statements = schema(this.driver.dialect)
    this.ready ??= this.driver
      .batch(statements)
      .catch((err: unknown) => {
        console.debug('execution tables made elsewhere first:', err)
        return this.driver.batch(statements)
      })
      .catch((err: unknown) => {
        this.ready = null
        throw err
      })
    return this.ready
  }

  private async query(key: keyof typeof EXECUTION_SQL, params: SqlValue[]): Promise<SqlRow[]> {
    await this.schema()
    return this.driver.query(EXECUTION_SQL[key], [this.scope, ...params])
  }

  private async batch(statements: SqlStatement[]): Promise<void> {
    await this.schema()
    await this.driver.batch(statements)
  }

  private async fields(kind: string, name: string): Promise<RecordFields | null> {
    const [row] = await this.query('get', [kind, name])
    return row === undefined ? null : (JSON.parse(String(row.fields)) as RecordFields)
  }

  /** Drop consoles no job list names any more. */
  private async drop(names: Set<string>): Promise<void> {
    if (names.size > 0) {
      await this.batch(
        [...names]
          .sort(compareCodePoints)
          .map((name) => ({ sql: EXECUTION_SQL.drop_console, params: [this.scope, name] })),
      )
    }
    for (const name of names) this.consoles.delete(name)
  }

  load(sessionId: string): Promise<RecordFields | null> {
    return this.fields('list', sessionId)
  }

  async casSet(
    sessionId: string,
    fields: RecordFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    const stored = await this.fields('list', sessionId)
    const body = JSON.stringify(fields)
    const generation = generationOf(fields)
    const landed =
      expectedGeneration === 0
        ? await this.query('insert_new', [sessionId, body, generation])
        : await this.driver.query(EXECUTION_SQL.update_at, [
            body,
            generation,
            this.scope,
            sessionId,
            expectedGeneration,
          ])
    if (landed.length === 0) return false
    const kept = consoleNames(fields)
    await this.drop(new Set([...consoleNames(stored)].filter((name) => !kept.has(name))))
    return true
  }

  async delete(sessionId: string, expectedGeneration: number): Promise<boolean> {
    const [row] = await this.query('delete_at', [sessionId, expectedGeneration])
    if (row !== undefined) {
      await this.drop(consoleNames(JSON.parse(String(row.fields)) as RecordFields))
      return true
    }
    return expectedGeneration === 0 && (await this.fields('list', sessionId)) === null
  }

  console(name: string): SqlConsoleStore {
    let store = this.consoles.get(name)
    if (store === undefined) {
      store = new SqlConsoleStore(this.driver, this.scope, name, () => this.schema())
      this.consoles.set(name, store)
    }
    return store
  }

  async lease(daemon: string, _consoles: readonly string[] = []): Promise<string | null> {
    for (;;) {
      const now = Date.now() / 1000
      const expires = this.leaseSeconds === null ? null : now + this.leaseSeconds
      const held = await this.query('lease', [JSON.stringify(daemon), expires, now])
      if (held.length > 0) return null
      // Refused, and released before the holder was read: ask again.
      const holder = await this.holder()
      if (holder !== null) return holder
    }
  }

  async holder(): Promise<string | null> {
    const [row] = await this.query('get', ['lease', ''])
    if (row === undefined) return null
    const ended = row.ended
    if (ended !== null && ended !== undefined && Number(ended) <= Date.now() / 1000) return null
    return JSON.parse(String(row.fields)) as string
  }

  async release(daemon: string): Promise<void> {
    await this.query('release', [JSON.stringify(daemon)])
  }

  async publish(
    daemon: string,
    processes: Readonly<Record<string, RecordFields>>,
    lastPid = 0,
  ): Promise<void> {
    const statements: SqlStatement[] = [
      { sql: EXECUTION_SQL.raise_pid, params: [this.scope, lastPid] },
    ]
    if (Object.keys(processes).length > 0) {
      statements.push({
        sql: EXECUTION_SQL.put,
        params: [this.scope, 'published', daemon, JSON.stringify(processes), 0, null],
      })
    } else {
      statements.push(
        { sql: EXECUTION_SQL.delete, params: [this.scope, 'published', daemon] },
        { sql: EXECUTION_SQL.delete_kind, params: [this.scope, `stop:${daemon}`] },
      )
    }
    await this.batch(statements)
  }

  async processes(): Promise<Record<string, Record<string, RecordFields>>> {
    const rows = await this.query('kind', ['published'])
    return Object.fromEntries(
      rows.map((row) => [
        String(row.name),
        JSON.parse(String(row.fields)) as Record<string, RecordFields>,
      ]),
    )
  }

  async highestPid(): Promise<number> {
    const [row] = await this.query('get', ['pid', ''])
    return row === undefined ? 0 : Number(row.generation ?? 0)
  }

  async requestStop(daemon: string, pid: number, signal: number): Promise<void> {
    // Named by when it was asked, in microseconds, which both hosts count
    // exactly; a stop asked in the same microsecond takes the next.
    let at = Date.now() * 1000
    const body = JSON.stringify([pid, signal])
    while ((await this.query('add_stop', [`stop:${daemon}`, String(at), body, at])).length === 0) {
      at += 1
    }
  }

  async takeStops(daemon: string): Promise<[number, number][]> {
    const rows = await this.query('take_kind', [`stop:${daemon}`])
    return rows
      .sort((a, b) => Number(a.generation ?? 0) - Number(b.generation ?? 0))
      .map((row) => JSON.parse(String(row.fields)) as [number, number])
  }

  note(record: Line | Process): void {
    const [kind, name] = recordOf(record)
    this.pending.set(`${kind}:${name}`, record)
    this.writing ??= this.writePending()
  }

  /**
   * Write the records noted since the last batch, until none are left,
   * trimming each kind's ended ones to the history; a batch that fails is
   * logged and dropped.
   */
  private async writePending(): Promise<void> {
    for (;;) {
      if (this.pending.size === 0) {
        this.writing = null
        return
      }
      this.inflight = new Map(this.pending)
      const batch = [...this.pending.values()]
      this.pending.clear()
      const statements: SqlStatement[] = []
      const newest = new Map<string, number>()
      for (const record of batch) {
        const [kind, name, fields] = recordOf(record)
        statements.push({
          sql: EXECUTION_SQL.put,
          params: [this.scope, kind, name, JSON.stringify(fields), 0, record.endedAt],
        })
        if (record.endedAt !== null)
          newest.set(kind, Math.max(newest.get(kind) ?? record.endedAt, record.endedAt))
      }
      for (const [kind, ended] of newest) {
        statements.push({
          sql: EXECUTION_SQL.prune,
          params: [
            this.scope,
            kind,
            ended - HISTORY_SECONDS,
            this.scope,
            kind,
            HISTORY_MAX_RECORDS,
          ],
        })
      }
      try {
        await this.batch(statements)
      } catch (err) {
        console.debug('execution records not written:', err)
      } finally {
        this.inflight = new Map()
      }
    }
  }

  /** The records noted but not written yet, of one kind. */
  private noted(kind: string): (Line | Process)[] {
    return [...new Map([...this.inflight, ...this.pending]).values()].filter(
      (record) => recordOf(record)[0] === kind,
    )
  }

  /** One record noted but not written yet. */
  private notedOne(key: string): Line | Process | undefined {
    return this.pending.get(key) ?? this.inflight.get(key)
  }

  async sessions(): Promise<string[]> {
    const rows = await this.query('kind', ['list'])
    return rows.map((row) => String(row.name)).sort(compareCodePoints)
  }

  async getLine(lineId: LineId): Promise<Line | null> {
    const noted = this.notedOne(`line:${lineId.value}`)
    if (noted !== undefined) return noted as Line
    const fields = await this.fields('line', lineId.value)
    return fields === null ? null : lineFromFields(fields)
  }

  async getProcess(processId: ProcessId): Promise<Process | null> {
    const noted = this.notedOne(`process:${String(processId.pid)}`)
    if (noted !== undefined) return noted as Process
    const fields = await this.fields('process', String(processId.pid))
    return fields === null ? null : processFromFields(fields)
  }

  async findLines(sessionId?: string): Promise<Line[]> {
    const found = new Map<string, Line>()
    for (const row of await this.query('kind', ['line'])) {
      const line = lineFromFields(JSON.parse(String(row.fields)) as RecordFields)
      found.set(line.id.value, line)
    }
    for (const line of this.noted('line') as Line[]) found.set(line.id.value, line)
    return [...found.values()]
      .filter((line) => sessionId === undefined || line.sessionId === sessionId)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  async findProcesses(sessionId?: string): Promise<Process[]> {
    const found = new Map<number, Process>()
    for (const row of await this.query('kind', ['process'])) {
      const record = processFromFields(JSON.parse(String(row.fields)) as RecordFields)
      found.set(record.id.pid, record)
    }
    for (const record of this.noted('process') as Process[]) found.set(record.id.pid, record)
    return [...found.values()]
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .sort((a, b) => a.id.pid - b.id.pid)
  }

  async clear(): Promise<void> {
    await this.writing
    await this.batch([
      { sql: EXECUTION_SQL.clear, params: [this.scope] },
      { sql: EXECUTION_SQL.clear_consoles, params: [this.scope] },
    ])
    this.consoles.clear()
  }

  async close(): Promise<void> {
    await this.writing
    for (const store of this.consoles.values()) await store.close()
  }
}
