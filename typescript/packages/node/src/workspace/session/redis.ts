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

import type { RedisClientType } from 'redis'
import { SessionStore, type SessionFields } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../../optional_peer.ts'

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
  private clientPromise: Promise<RedisClientType> | null = null

  constructor(options: RedisSessionStoreOptions = {}) {
    super()
    this.url = options.url ?? 'redis://localhost:6379/0'
    const prefix = options.keyPrefix ?? 'mirage:session:'
    this.key = `${prefix}sessions`
  }

  private async client(): Promise<RedisClientType> {
    this.clientPromise ??= (async () => {
      const mod = await loadOptionalPeer(
        () =>
          import('redis') as unknown as Promise<{
            createClient: (o: { url: string }) => RedisClientType
          }>,
        { feature: 'RedisSessionStore', packageName: 'redis' },
      )
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      } as Parameters<typeof mod.createClient>[0])
      await c.connect()
      return c
    })()
    return this.clientPromise
  }

  async load(): Promise<Map<string, SessionFields>> {
    const c = await this.client()
    const raw = await c.hGetAll(this.key)
    const out = new Map<string, SessionFields>()
    for (const [sid, value] of Object.entries(raw)) {
      out.set(sid, JSON.parse(value) as SessionFields)
    }
    return out
  }

  async set(sessionId: string, fields: SessionFields): Promise<void> {
    const c = await this.client()
    await c.hSet(this.key, sessionId, JSON.stringify(fields))
  }

  async delete(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return
    const c = await this.client()
    await c.hDel(this.key, [...sessionIds])
  }

  async replaceAll(entries: Map<string, SessionFields>): Promise<void> {
    const c = await this.client()
    const multi = c.multi().del(this.key)
    for (const [sid, fields] of entries) {
      multi.hSet(this.key, sid, JSON.stringify(fields))
    }
    await multi.exec()
  }

  async clear(): Promise<void> {
    const c = await this.client()
    await c.del(this.key)
  }

  async close(): Promise<void> {
    if (this.clientPromise === null) return
    const c = await this.clientPromise
    await c.quit()
  }
}
