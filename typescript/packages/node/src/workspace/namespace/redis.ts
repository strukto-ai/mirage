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
import { NamespaceStore, type NodeFields } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../../optional_peer.ts'

export interface RedisNamespaceStoreOptions {
  url?: string
  keyPrefix?: string
}

/**
 * NamespaceStore backed by one Redis hash (path -> JSON fields).
 *
 * Symlinks and attribute overlays survive process restarts and are visible
 * to any workspace pointed at the same key prefix. Writes are
 * single-command (HSET/HDEL) so mutations stay one round trip. Mirrors the
 * Python RedisNamespaceStore.
 */
export class RedisNamespaceStore extends NamespaceStore {
  readonly url: string
  private readonly key: string
  private clientPromise: Promise<RedisClientType> | null = null

  constructor(options: RedisNamespaceStoreOptions = {}) {
    super()
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.key = `${options.keyPrefix ?? 'mirage:namespace:'}nodes`
  }

  private async client(): Promise<RedisClientType> {
    this.clientPromise ??= (async () => {
      const mod = await loadOptionalPeer(
        () =>
          import('redis') as unknown as Promise<{
            createClient: (o: { url: string }) => RedisClientType
          }>,
        { feature: 'RedisNamespaceStore', packageName: 'redis' },
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

  async load(): Promise<Map<string, NodeFields>> {
    const c = await this.client()
    const raw = await c.hGetAll(this.key)
    const out = new Map<string, NodeFields>()
    for (const [path, value] of Object.entries(raw)) {
      out.set(path, JSON.parse(value) as NodeFields)
    }
    return out
  }

  async set(path: string, fields: NodeFields): Promise<void> {
    const c = await this.client()
    await c.hSet(this.key, path, JSON.stringify(fields))
  }

  async delete(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    const c = await this.client()
    await c.hDel(this.key, [...paths])
  }

  async replaceAll(entries: Map<string, NodeFields>): Promise<void> {
    const c = await this.client()
    const multi = c.multi().del(this.key)
    for (const [path, fields] of entries) {
      multi.hSet(this.key, path, JSON.stringify(fields))
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
