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
  CONSOLE_TTL_SECONDS,
  LEASE_SECONDS,
} from '@struktoai/mirage-core/shell/job_table/constants'
import { JobStore } from '@struktoai/mirage-core/shell/job_table/store'
import type { RecordFields } from '@struktoai/mirage-core/workspace/record/types'
import { RedisConnection } from '../../optional_peer.ts'
import { RedisConsoleStore } from '../console/redis/index.ts'
import { CAS_SCRIPT } from '../../workspace/mount/namespace/redis.ts'

export interface RedisJobStoreOptions {
  url?: string
  keyPrefix?: string
  /** See `JobStore`; null means owners never lapse. */
  leaseSeconds?: number | null
}

/**
 * JobStore on one Redis server, shared by every process on it.
 *
 * Key layout under one prefix:
 *
 * - `{prefix}lists`: a hash of session id to job list JSON, written with
 *   the session table's compare-and-set script
 * - `{prefix}console:{name}:*`: one console stream per job
 *   (`RedisConsoleStore`), expiring a day after its last write or its
 *   owner's last renewal
 * - `{prefix}owner:{id}`: an owner's lease, a key that expires
 *
 * One connection serves the lists, the leases and every console, so a
 * workspace holds one client however many jobs it follows. Mirrors
 * Python's `RedisJobStore`.
 */
export class RedisJobStore extends JobStore {
  readonly url: string
  private readonly prefix: string
  private readonly listsKey: string
  private readonly redis: RedisConnection

  constructor(options: RedisJobStoreOptions = {}) {
    super(options.leaseSeconds === undefined ? LEASE_SECONDS : options.leaseSeconds)
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.prefix = options.keyPrefix ?? 'mirage:jobs:'
    this.listsKey = `${this.prefix}lists`
    this.redis = new RedisConnection(this.url, 'RedisJobStore')
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

  async delete(sessionId: string): Promise<void> {
    const c = await this.redis.client()
    await c.hDel(this.listsKey, sessionId)
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
   * One round trip however many jobs the owner runs, so the lease is never
   * late behind its consoles.
   */
  async renew(owner: string, consoles: readonly string[] = []): Promise<void> {
    if (this.leaseSeconds === null && consoles.length === 0) return
    const c = await this.redis.client()
    const pipe = c.multi()
    if (this.leaseSeconds !== null)
      pipe.set(`${this.prefix}owner:${owner}`, '1', { PX: Math.round(this.leaseSeconds * 1000) })
    for (const name of consoles)
      for (const key of this.console(name).keys) pipe.expire(key, CONSOLE_TTL_SECONDS)
    await pipe.exec()
  }

  async alive(owner: string): Promise<boolean> {
    if (this.leaseSeconds === null) return true
    const c = await this.redis.client()
    return (await c.exists(`${this.prefix}owner:${owner}`)) > 0
  }

  async clear(): Promise<void> {
    const c = await this.redis.client()
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: `${this.prefix}*` })) {
      keys.push(...(Array.isArray(k) ? k : [k]))
    }
    if (keys.length > 0) await c.del(keys)
  }

  async close(): Promise<void> {
    await this.redis.close()
  }
}
