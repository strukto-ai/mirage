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
import { globEscape } from '@struktoai/mirage-core/cache/file/utils'
import { ExecutionStore } from '@struktoai/mirage-core/execution/base'
import { HISTORY_MAX_RECORDS, HISTORY_SECONDS } from '@struktoai/mirage-core/execution/constants'
import { CONSOLE_TTL_SECONDS, LEASE_SECONDS } from '@struktoai/mirage-core/execution/job/constants'
import type { Line } from '@struktoai/mirage-core/execution/line/types'
import type { Process } from '@struktoai/mirage-core/execution/process/types'
import {
  lineFromFields,
  lineToFields,
  processFromFields,
  processToFields,
} from '@struktoai/mirage-core/execution/serde'
import { type LineId, ProcessId } from '@struktoai/mirage-core/execution/types'
import { compareCodePoints } from '@struktoai/mirage-core/utils/sort'
import type { RecordFields } from '@struktoai/mirage-core/workspace/record/types'
import { RedisConnection } from '../optional_peer.ts'
import { RedisConsoleStore } from '../shell/console/redis/index.ts'
import { CAS_SCRIPT } from '../workspace/mount/namespace/redis.ts'

export const LEASE_SCRIPT = readFileSync(new URL('./lease.lua', import.meta.url), 'utf8')
export const PID_SCRIPT = readFileSync(new URL('./pid.lua', import.meta.url), 'utf8')
export const HISTORY_SCRIPT = readFileSync(new URL('./history.lua', import.meta.url), 'utf8')
// A longer workspace id ending in `:execution:processes` puts its session
// table at `processes:sessions`, so no daemon is named `sessions`.
export const OWN_KEY =
  /^(?:lists|lease|pid|(?:records|ended):(?:lines|processes)|console:[^:]+:(?:stream|seq|ended)|(?:processes|stops):(?!sessions$)[^:]+)$/

/** Refuse a daemon id or console name `OWN_KEY` would not count as this store's: empty, holding `:`, or `sessions`. */
function keyPart(name: string): string {
  if (name === '' || name.includes(':') || name === 'sessions') {
    throw new Error(`a redis execution store refuses an empty name, ':' or 'sessions': ${name}`)
  }
  return name
}

/** The hash a record is kept in, `lines` or `processes`, and its field there. */
function fieldOf(record: Line | Process): [string, string] {
  if (record.id instanceof ProcessId) return ['processes', String(record.id.pid)]
  return ['lines', (record as Line).id.value]
}

export interface RedisExecutionStoreOptions {
  url?: string
  keyPrefix?: string
  /** See `ExecutionStore`; null means a lease holds until released. */
  leaseSeconds?: number | null
}

/**
 * ExecutionStore on one Redis server, shared by every process on it.
 *
 * Key layout under one prefix:
 *
 * - `{prefix}lists`: a hash of session id to job list JSON, written with
 *   the session table's compare-and-set script
 * - `{prefix}console:{name}:*`: one console stream per job
 *   (`RedisConsoleStore`), expiring a day after its last write or the last
 *   renewal of the lease while its job ran
 * - `{prefix}lease`: the id of the daemon holding the workspace's lease, a
 *   key that expires, taken and released by `lease.lua`
 * - `{prefix}pid`: the highest pid published, raised by `pid.lua`
 * - `{prefix}processes:{id}`: the processes a daemon runs, as JSON, kept a
 *   day after its last publish so the runs of one that lost the lease can
 *   still be found
 * - `{prefix}stops:{id}`: a list of the stops asked of a daemon
 * - `{prefix}records:lines` and `{prefix}records:processes`: a hash of id to
 *   record JSON, written by `history.lua`, which keeps each kind's ended ones
 *   in `{prefix}ended:lines` and `{prefix}ended:processes`, sorted sets by
 *   end, trimmed to the history; both expire a day after their last write
 *
 * One connection serves the lists, the lease and every console, so a
 * workspace holds one client however many jobs it follows. Records are
 * written in the background, in batches, the newest of each winning;
 * `close` writes what is left. Mirrors Python's `RedisExecutionStore`.
 */
export class RedisExecutionStore extends ExecutionStore {
  readonly url: string
  private readonly prefix: string
  private readonly listsKey: string
  private readonly leaseKey: string
  private readonly pidKey: string
  private readonly redis: RedisConnection
  private raised = 0
  private readonly pending = new Map<string, Line | Process>()
  private inflight = new Map<string, Line | Process>()
  private writing: Promise<void> | null = null

  constructor(options: RedisExecutionStoreOptions = {}) {
    super(options.leaseSeconds === undefined ? LEASE_SECONDS : options.leaseSeconds)
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.prefix = options.keyPrefix ?? 'mirage:jobs:'
    this.listsKey = `${this.prefix}lists`
    this.leaseKey = `${this.prefix}lease`
    this.pidKey = `${this.prefix}pid`
    this.redis = new RedisConnection(this.url, 'RedisExecutionStore')
  }

  async load(sessionId: string): Promise<RecordFields | null> {
    const c = await this.redis.client()
    const raw = await c.hGet(this.listsKey, sessionId)
    return raw != null ? (JSON.parse(raw) as RecordFields) : null
  }

  async casSet(
    sessionId: string,
    fields: RecordFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    const c = await this.redis.client()
    const result = await c.eval(CAS_SCRIPT, {
      keys: [this.listsKey],
      arguments: [sessionId, JSON.stringify(fields), String(expectedGeneration)],
    })
    return result === 1
  }

  async delete(sessionId: string, expectedGeneration: number): Promise<boolean> {
    const c = await this.redis.client()
    const result = await c.eval(CAS_SCRIPT, {
      keys: [this.listsKey],
      arguments: [sessionId, '', String(expectedGeneration)],
    })
    return result === 1
  }

  note(record: Line | Process): void {
    this.pending.set(fieldOf(record).join(':'), record)
    this.writing ??= this.writePending()
  }

  /** Write the records noted since the last batch, until none are left; a batch that fails is logged and dropped. */
  private async writePending(): Promise<void> {
    for (;;) {
      if (this.pending.size === 0) {
        this.writing = null
        return
      }
      this.inflight = new Map(this.pending)
      const batch = [...this.pending.values()]
      this.pending.clear()
      try {
        const c = await this.redis.client()
        const pipe = c.multi()
        for (const record of batch) {
          const [kind, field] = fieldOf(record)
          const fields =
            kind === 'lines' ? lineToFields(record as Line) : processToFields(record as Process)
          pipe.eval(HISTORY_SCRIPT, {
            keys: [`${this.prefix}records:${kind}`, `${this.prefix}ended:${kind}`],
            arguments: [
              field,
              JSON.stringify(fields),
              record.endedAt === null ? '' : String(record.endedAt),
              String(HISTORY_MAX_RECORDS),
              String(HISTORY_SECONDS),
              String(CONSOLE_TTL_SECONDS),
            ],
          })
        }
        await pipe.exec()
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
      (record) => fieldOf(record)[0] === kind,
    )
  }

  /** One record noted but not written yet. */
  private notedOne(key: string): Line | Process | undefined {
    return this.pending.get(key) ?? this.inflight.get(key)
  }

  async sessions(): Promise<string[]> {
    const c = await this.redis.client()
    return (await c.hKeys(this.listsKey)).sort(compareCodePoints)
  }

  async getLine(lineId: LineId): Promise<Line | null> {
    const noted = this.notedOne(`lines:${lineId.value}`)
    if (noted !== undefined) return noted as Line
    const c = await this.redis.client()
    const raw = await c.hGet(`${this.prefix}records:lines`, lineId.value)
    return raw != null ? lineFromFields(JSON.parse(raw) as RecordFields) : null
  }

  async getProcess(processId: ProcessId): Promise<Process | null> {
    const noted = this.notedOne(`processes:${String(processId.pid)}`)
    if (noted !== undefined) return noted as Process
    const c = await this.redis.client()
    const raw = await c.hGet(`${this.prefix}records:processes`, String(processId.pid))
    return raw != null ? processFromFields(JSON.parse(raw) as RecordFields) : null
  }

  async findLines(sessionId?: string): Promise<Line[]> {
    const c = await this.redis.client()
    const raw = await c.hGetAll(`${this.prefix}records:lines`)
    const found = new Map<string, Line>()
    for (const value of Object.values(raw)) {
      const line = lineFromFields(JSON.parse(value) as RecordFields)
      found.set(line.id.value, line)
    }
    for (const line of this.noted('lines') as Line[]) found.set(line.id.value, line)
    return [...found.values()]
      .filter((line) => sessionId === undefined || line.sessionId === sessionId)
      .sort((a, b) => a.startedAt - b.startedAt)
  }

  async findProcesses(sessionId?: string): Promise<Process[]> {
    const c = await this.redis.client()
    const raw = await c.hGetAll(`${this.prefix}records:processes`)
    const found = new Map<number, Process>()
    for (const value of Object.values(raw)) {
      const record = processFromFields(JSON.parse(value) as RecordFields)
      found.set(record.id.pid, record)
    }
    for (const record of this.noted('processes') as Process[]) found.set(record.id.pid, record)
    return [...found.values()]
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .sort((a, b) => a.id.pid - b.id.pid)
  }

  console(name: string): RedisConsoleStore {
    return new RedisConsoleStore({
      url: this.url,
      keyPrefix: `${this.prefix}console:${keyPart(name)}:`,
      ttlSeconds: CONSOLE_TTL_SECONDS,
      connection: this.redis,
    })
  }

  /**
   * One round trip with no consoles to keep, and one transaction however
   * many jobs the daemon runs, so the lease is never late behind its
   * consoles.
   */
  async lease(daemon: string, consoles: readonly string[] = []): Promise<string | null> {
    const c = await this.redis.client()
    const options = {
      keys: [this.leaseKey],
      arguments: [
        daemon,
        'take',
        this.leaseSeconds === null ? '' : String(Math.round(this.leaseSeconds * 1000)),
      ],
    }
    // The line and process records are kept another day with the lease, so a
    // quiet run outlives no record.
    const pipe = c.multi().eval(LEASE_SCRIPT, options)
    for (const kind of ['lines', 'processes']) {
      pipe.expire(`${this.prefix}records:${kind}`, CONSOLE_TTL_SECONDS)
      pipe.expire(`${this.prefix}ended:${kind}`, CONSOLE_TTL_SECONDS)
    }
    for (const name of consoles)
      for (const key of this.console(name).keys) pipe.expire(key, CONSOLE_TTL_SECONDS)
    const [held] = (await pipe.exec()) as unknown as [string | null]
    return held
  }

  async holder(): Promise<string | null> {
    const c = await this.redis.client()
    return await c.get(this.leaseKey)
  }

  async release(daemon: string): Promise<void> {
    const c = await this.redis.client()
    await c.eval(LEASE_SCRIPT, { keys: [this.leaseKey], arguments: [daemon, 'release', ''] })
  }

  async publish(
    daemon: string,
    processes: Readonly<Record<string, RecordFields>>,
    lastPid = 0,
  ): Promise<void> {
    const c = await this.redis.client()
    const key = `${this.prefix}processes:${keyPart(daemon)}`
    if (lastPid > this.raised) {
      await c.eval(PID_SCRIPT, { keys: [this.pidKey], arguments: [String(lastPid)] })
      this.raised = lastPid
    }
    if (Object.keys(processes).length === 0) {
      await c.del([key, `${this.prefix}stops:${daemon}`])
      return
    }
    await c.set(key, JSON.stringify(processes), { EX: CONSOLE_TTL_SECONDS })
  }

  async processes(): Promise<Record<string, Record<string, RecordFields>>> {
    const c = await this.redis.client()
    const head = `${this.prefix}processes:`
    const keys = await this.ownKeys('processes:')
    if (keys.length === 0) return {}
    const values = await c.mGet(keys)
    const found: Record<string, Record<string, RecordFields>> = {}
    keys.forEach((key, at) => {
      const value = values[at]
      if (value != null)
        found[key.slice(head.length)] = JSON.parse(value) as Record<string, RecordFields>
    })
    return found
  }

  /**
   * This store's keys under `{prefix}{family}`. Another store's prefix can
   * start with this one, as workspace `a:execution:x`'s does with `a`'s, so a
   * key counts only in a shape this store writes.
   */
  private async ownKeys(family: string): Promise<string[]> {
    const c = await this.redis.client()
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: `${globEscape(this.prefix + family)}*` })) {
      keys.push(...(Array.isArray(k) ? k : [k]))
    }
    return keys.filter((key) => OWN_KEY.test(key.slice(this.prefix.length)))
  }

  async highestPid(): Promise<number> {
    const c = await this.redis.client()
    return Number((await c.get(this.pidKey)) ?? 0)
  }

  async requestStop(daemon: string, pid: number, signal: number): Promise<void> {
    const c = await this.redis.client()
    const key = `${this.prefix}stops:${keyPart(daemon)}`
    await c
      .multi()
      .rPush(key, JSON.stringify([pid, signal]))
      .expire(key, CONSOLE_TTL_SECONDS)
      .exec()
  }

  async takeStops(daemon: string): Promise<[number, number][]> {
    const c = await this.redis.client()
    const key = `${this.prefix}stops:${daemon}`
    const [raw] = (await c.multi().lRange(key, 0, -1).del(key).exec()) as unknown as [string[]]
    return raw.map((item) => JSON.parse(item) as [number, number])
  }

  async clear(): Promise<void> {
    await this.writing
    const c = await this.redis.client()
    const keys = await this.ownKeys('')
    if (keys.length > 0) await c.del(keys)
    this.raised = 0
  }

  async close(): Promise<void> {
    await this.writing
    await this.redis.close()
  }
}
