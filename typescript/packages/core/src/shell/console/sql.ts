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

import type { SqlDriver, SqlRow, SqlValue } from '../../vfs/sql/types.ts'
import { SQL_POLL_SECONDS } from './constants.ts'
import type { ConsoleStore } from './store.ts'
import { Channel, type ConsoleChunk, type ReadResult } from './types.ts'

/** Every statement the sql console store runs, by name. Mirrors Python's `CONSOLE_SQL`. */
export const CONSOLE_SQL = Object.freeze({
  top: 'SELECT seq, channel FROM mirage_console WHERE scope = ? AND name = ? ORDER BY seq DESC LIMIT 1',
  append:
    'INSERT INTO mirage_console (scope, name, seq, ts, channel, data) VALUES (?, ?, ?, ?, ?, ?)' +
    ' ON CONFLICT (scope, name, seq) DO NOTHING RETURNING seq',
  last:
    'SELECT seq, ts, channel, data FROM mirage_console' +
    ' WHERE scope = ? AND name = ? ORDER BY seq DESC LIMIT 1',
  read:
    'SELECT seq, ts, channel, data FROM mirage_console' +
    ' WHERE scope = ? AND name = ? AND seq >= ? ORDER BY seq',
  read_some:
    'SELECT seq, ts, channel, data FROM mirage_console' +
    ' WHERE scope = ? AND name = ? AND seq >= ? ORDER BY seq LIMIT ?',
} as const)

/** The bytes a BLOB or BYTEA column came back as. */
function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  return new Uint8Array()
}

/** The chunk one `mirage_console` row holds. */
function chunkOf(row: SqlRow): ConsoleChunk {
  return {
    seq: Number(row.seq ?? 0),
    ts: Number(row.ts ?? 0),
    channel: row.channel as Channel,
    data: bytesOf(row.data),
  }
}

/**
 * One job's console in a SQL database, as `mirage_console` rows: one per
 * chunk, keyed by the console's name and its seq, so any process on the
 * database reads, follows and ends it.
 *
 * A chunk's seq is one past the console's last, taken by a conditional
 * insert that a concurrent append makes retry, so two writers never share a
 * seq. The ending chunk is terminal, as in RAM and Redis: an append after a
 * CONTROL chunk is dropped. Nothing is trimmed; the execution store drops a
 * console once no job list names it.
 *
 * A database has no blocking read, so a waiting reader looks again every
 * `pollSeconds`; an append or a close through this store wakes its own
 * readers at once. `ready` makes the tables, once. Mirrors Python's
 * `SqlConsoleStore`.
 */
export class SqlConsoleStore implements ConsoleStore {
  private isClosed = false
  private appends = 0
  private waiters = new Set<() => void>()

  constructor(
    private readonly driver: SqlDriver,
    private readonly scope: string,
    private readonly name: string,
    private readonly ready: () => Promise<void>,
    private readonly pollSeconds = SQL_POLL_SECONDS,
  ) {}

  get closed(): boolean {
    return this.isClosed
  }

  private async query(key: keyof typeof CONSOLE_SQL, params: SqlValue[]): Promise<SqlRow[]> {
    await this.ready()
    return this.driver.query(CONSOLE_SQL[key], [this.scope, this.name, ...params])
  }

  /**
   * The console's last seq, null while it is empty, and whether it holds its
   * ending, which is always its last chunk: one indexed row, however long the
   * console.
   */
  private async top(): Promise<[number | null, boolean]> {
    const [row] = await this.query('top', [])
    if (row === undefined) return [null, false]
    return [Number(row.seq ?? 0), row.channel === Channel.CONTROL]
  }

  async append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    for (;;) {
      const [top, ended] = await this.top()
      if (ended) {
        const [row] = await this.query('last', [])
        if (row !== undefined) return chunkOf(row)
      }
      const chunk: ConsoleChunk = {
        seq: top === null ? 0 : top + 1,
        ts: Date.now() / 1000,
        channel,
        data,
      }
      const landed = await this.query('append', [chunk.seq, chunk.ts, channel, data])
      if (landed.length > 0) {
        this.wake()
        return chunk
      }
    }
  }

  async readFrom(seq: number, limit?: number): Promise<ReadResult> {
    const rows =
      limit === undefined
        ? await this.query('read', [seq])
        : await this.query('read_some', [seq, limit])
    const chunks = rows.map(chunkOf)
    const last = chunks.at(-1)
    if (last !== undefined) return [chunks, last.seq + 1, false]
    const [top] = await this.top()
    return [[], Math.min(seq, top === null ? 0 : top + 1), false]
  }

  async wait(seq: number, signal?: AbortSignal): Promise<void> {
    while (!this.isClosed && signal?.aborted !== true) {
      const seen = this.appends
      const [top] = await this.top()
      if (top !== null && top >= seq) return
      await this.park(seen, signal)
    }
  }

  async waitEnded(signal?: AbortSignal): Promise<void> {
    while (!this.isClosed && signal?.aborted !== true) {
      const seen = this.appends
      const [, ended] = await this.top()
      if (ended) return
      await this.park(seen, signal)
    }
  }

  close(): Promise<void> {
    this.isClosed = true
    this.wake()
    return Promise.resolve()
  }

  /**
   * Wait for an append or a close through this store, an abort, or the next
   * look, whichever comes first; nothing when one came since `seen`.
   */
  private park(seen: number, signal?: AbortSignal): Promise<void> {
    if (this.isClosed || this.appends !== seen) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, this.pollSeconds * 1000)
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Wake every reader waiting through this store. */
  private wake(): void {
    this.appends += 1
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const done of waiters) done()
  }
}
