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
import { SessionStore } from '@struktoai/mirage-core/workspace/session/store'
import type { SessionFields } from '@struktoai/mirage-core/workspace/session/store'
import { RedisConnection } from '../../optional_peer.ts'

// Shipped next to this module in src and copied beside the bundle in
// dist (scripts/copy-assets.mjs); byte-identical to the Python cas.lua. Generic
// hash-field CAS, shared with the workspace meta record.
export const CAS_SCRIPT = readFileSync(new URL('./cas.lua', import.meta.url), 'utf8')

export interface RedisSessionStoreOptions {
  url?: string
  keyPrefix?: string
}

/**
 * SessionStore backed by one Redis hash (session id -> JSON fields).
 *
 * Sessions and the mount grants they carry survive restarts and are
 * visible to every workspace pointed at the same key prefix — the seam
 * that lets one process create a session and another (a kernel tier, a
 * sibling daemon) bind a mountpoint to it. Writes are single-command
 * (HSET/HDEL) so mutations stay one round trip. Mirrors the Python
 * RedisSessionStore.
 */
export class RedisSessionStore extends SessionStore {
  readonly url: string
  private readonly key: string
  private readonly redis: RedisConnection

  constructor(options: RedisSessionStoreOptions = {}) {
    super()
    this.url = options.url ?? 'redis://localhost:6379/0'
    const prefix = options.keyPrefix ?? 'mirage:session:'
    this.key = `${prefix}sessions`
    this.redis = new RedisConnection(this.url, 'RedisSessionStore')
  }

  // One atomic server-side compare-and-set: Lua reads the stored
  // record's generation and writes only on a match.
  async casSet(
    sessionId: string,
    fields: SessionFields,
    expectedGeneration: number,
  ): Promise<boolean> {
    const c = await this.redis.client()
    const result = await c.eval(CAS_SCRIPT, {
      keys: [this.key],
      arguments: [sessionId, JSON.stringify(fields), String(expectedGeneration)],
    })
    return result === 1
  }

  async load(): Promise<Map<string, SessionFields>> {
    const c = await this.redis.client()
    const raw = await c.hGetAll(this.key)
    const out = new Map<string, SessionFields>()
    for (const [sid, value] of Object.entries(raw)) {
      out.set(sid, JSON.parse(value) as SessionFields)
    }
    return out
  }

  async set(sessionId: string, fields: SessionFields): Promise<void> {
    const c = await this.redis.client()
    await c.hSet(this.key, sessionId, JSON.stringify(fields))
  }

  async delete(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return
    const c = await this.redis.client()
    await c.hDel(this.key, [...sessionIds])
  }

  async replaceAll(entries: Map<string, SessionFields>): Promise<void> {
    const c = await this.redis.client()
    const multi = c.multi().del(this.key)
    for (const [sid, fields] of entries) {
      multi.hSet(this.key, sid, JSON.stringify(fields))
    }
    await multi.exec()
  }

  async clear(): Promise<void> {
    const c = await this.redis.client()
    await c.del(this.key)
  }

  async close(): Promise<void> {
    await this.redis.close()
  }
}
