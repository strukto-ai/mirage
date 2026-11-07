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
import { ExecutionStore } from '@struktoai/mirage-core/execution/base'
import { CONSOLE_TTL_SECONDS, LEASE_SECONDS } from '@struktoai/mirage-core/execution/job/constants'
import type { RecordFields } from '@struktoai/mirage-core/workspace/record/types'
import { RedisConnection } from '../optional_peer.ts'
import { RedisConsoleStore } from '../shell/console/redis/index.ts'
import { CAS_SCRIPT } from '../workspace/mount/namespace/redis.ts'

export const LEASE_SCRIPT = readFileSync(new URL('./lease.lua', import.meta.url), 'utf8')
export const PID_SCRIPT = readFileSync(new URL('./pid.lua', import.meta.url), 'utf8')

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
 *
 * One connection serves the lists, the lease and every console, so a
 * workspace holds one client however many jobs it follows. Mirrors
 * Python's `RedisExecutionStore`.
 */
export class RedisExecutionStore extends ExecutionStore {
  readonly url: string
  private readonly prefix: string
  private readonly listsKey: string
  private readonly leaseKey: string
  private readonly pidKey: string
  private readonly redis: RedisConnection
  private raised = 0

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

  console(name: string): RedisConsoleStore {
    return new RedisConsoleStore({
      url: this.url,
      keyPrefix: `${this.prefix}console:${name}:`,
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
    if (consoles.length === 0) return (await c.eval(LEASE_SCRIPT, options)) as string | null
    const pipe = c.multi().eval(LEASE_SCRIPT, options)
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
    const key = `${this.prefix}processes:${daemon}`
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
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: `${head}*` })) {
      keys.push(...(Array.isArray(k) ? k : [k]))
    }
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

  async highestPid(): Promise<number> {
    const c = await this.redis.client()
    return Number((await c.get(this.pidKey)) ?? 0)
  }

  async requestStop(daemon: string, pid: number, signal: number): Promise<void> {
    const c = await this.redis.client()
    const key = `${this.prefix}stops:${daemon}`
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
    const c = await this.redis.client()
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: `${this.prefix}*` })) {
      keys.push(...(Array.isArray(k) ? k : [k]))
    }
    if (keys.length > 0) await c.del(keys)
    this.raised = 0
  }

  async close(): Promise<void> {
    await this.redis.close()
  }
}
