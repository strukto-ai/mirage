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

import { NamespaceStore } from '@struktoai/mirage-core/workspace/mount/namespace/store'
import type { NodeFields } from '@struktoai/mirage-core/workspace/mount/namespace/store'
import { RedisConnection } from '../../../optional_peer.ts'

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
  private readonly userKey: string
  private readonly redis: RedisConnection

  constructor(options: RedisNamespaceStoreOptions = {}) {
    super()
    this.url = options.url ?? 'redis://localhost:6379/0'
    const prefix = options.keyPrefix ?? 'mirage:namespace:'
    this.key = `${prefix}nodes`
    this.userKey = `${prefix}user`
    this.redis = new RedisConnection(this.url, 'RedisNamespaceStore')
  }

  async load(): Promise<Map<string, NodeFields>> {
    const c = await this.redis.client()
    const raw = await c.hGetAll(this.key)
    const out = new Map<string, NodeFields>()
    for (const [path, value] of Object.entries(raw)) {
      out.set(path, JSON.parse(value) as NodeFields)
    }
    return out
  }

  async set(path: string, fields: NodeFields): Promise<void> {
    const c = await this.redis.client()
    await c.hSet(this.key, path, JSON.stringify(fields))
  }

  async delete(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return
    const c = await this.redis.client()
    await c.hDel(this.key, [...paths])
  }

  async replaceAll(entries: Map<string, NodeFields>): Promise<void> {
    const c = await this.redis.client()
    const multi = c.multi().del(this.key)
    for (const [path, fields] of entries) {
      multi.hSet(this.key, path, JSON.stringify(fields))
    }
    await multi.exec()
  }

  async loadUser(): Promise<string | null> {
    const c = await this.redis.client()
    return c.get(this.userKey)
  }

  async setUser(user: string): Promise<void> {
    const c = await this.redis.client()
    await c.set(this.userKey, user)
  }

  async clear(): Promise<void> {
    const c = await this.redis.client()
    await c.del([this.key, this.userKey])
  }

  async close(): Promise<void> {
    await this.redis.close()
  }
}
