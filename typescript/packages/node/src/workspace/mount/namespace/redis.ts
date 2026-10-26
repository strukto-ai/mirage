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
import { NamespaceStore } from '@struktoai/mirage-core/workspace/mount/namespace/store'
import type { RecordFields } from '@struktoai/mirage-core/workspace/record/types'
import { RedisConnection } from '../../../optional_peer.ts'

// Shipped next to this module in src and copied beside the bundle in
// dist (scripts/copy-assets.mjs); byte-identical to the Python cas.lua. Generic
// hash-field CAS, shared with the workspace meta record.
export const CAS_SCRIPT = readFileSync(new URL('./cas.lua', import.meta.url), 'utf8')

export interface RedisNamespaceStoreOptions {
  url?: string
  keyPrefix?: string
  // The hash's name under the prefix.
  table?: string
}

/**
 * NamespaceStore backed by one Redis hash (key -> JSON fields).
 *
 * Symlinks, attribute overlays, sessions and the mount grants they carry
 * survive process restarts and are visible to any workspace pointed at the
 * same key prefix, which is what lets a kernel tier bind a session-bound
 * mountpoint another daemon created. Writes are single-command (HSET/HDEL,
 * or one Lua compare-and-set) so mutations stay one round trip. Mirrors the
 * Python RedisNamespaceStore.
 */
export class RedisNamespaceStore extends NamespaceStore {
  readonly url: string
  private readonly key: string
  private readonly redis: RedisConnection

  constructor(options: RedisNamespaceStoreOptions = {}) {
    super()
    this.url = options.url ?? 'redis://localhost:6379/0'
    const prefix = options.keyPrefix ?? 'mirage:namespace:'
    this.key = `${prefix}${options.table ?? 'nodes'}`
    this.redis = new RedisConnection(this.url, 'RedisNamespaceStore')
  }

  async load(): Promise<Map<string, RecordFields>> {
    const c = await this.redis.client()
    const raw = await c.hGetAll(this.key)
    const out = new Map<string, RecordFields>()
    for (const [key, value] of Object.entries(raw)) {
      out.set(key, JSON.parse(value) as RecordFields)
    }
    return out
  }

  async set(key: string, fields: RecordFields): Promise<void> {
    const c = await this.redis.client()
    await c.hSet(this.key, key, JSON.stringify(fields))
  }

  async casSet(key: string, fields: RecordFields, expectedGeneration: number): Promise<boolean> {
    const c = await this.redis.client()
    const result = await c.eval(CAS_SCRIPT, {
      keys: [this.key],
      arguments: [key, JSON.stringify(fields), String(expectedGeneration)],
    })
    return result === 1
  }

  async delete(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return
    const c = await this.redis.client()
    await c.hDel(this.key, [...keys])
  }

  async replaceAll(entries: Map<string, RecordFields>): Promise<void> {
    const c = await this.redis.client()
    const multi = c.multi().del(this.key)
    for (const [key, fields] of entries) {
      multi.hSet(this.key, key, JSON.stringify(fields))
    }
    await multi.exec()
  }

  async clear(): Promise<void> {
    const c = await this.redis.client()
    await c.del([this.key])
  }

  async close(): Promise<void> {
    await this.redis.close()
  }
}
