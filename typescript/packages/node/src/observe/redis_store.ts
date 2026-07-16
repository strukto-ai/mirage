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
import type { ObserverStore } from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../optional_peer.ts'

export interface RedisObserverStoreOptions {
  url?: string
  keyPrefix?: string
}

/**
 * ObserverStore backed by Redis strings (one key per JSONL file).
 *
 * Appends use the atomic Redis APPEND command; an index set tracks which
 * file keys exist so readAll needs no SCAN. Mirrors the Python
 * RedisObserverStore.
 */
export class RedisObserverStore implements ObserverStore {
  readonly url: string
  private readonly prefix: string
  private readonly indexKey: string
  private clientPromise: Promise<RedisClientType> | null = null

  constructor(options: RedisObserverStoreOptions = {}) {
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.prefix = options.keyPrefix ?? 'mirage:observer:'
    this.indexKey = `${this.prefix}keys`
  }

  private async client(): Promise<RedisClientType> {
    this.clientPromise ??= (async () => {
      const mod = await loadOptionalPeer(
        () =>
          import('redis') as unknown as Promise<{
            createClient: (o: { url: string }) => RedisClientType
          }>,
        { feature: 'RedisObserverStore', packageName: 'redis' },
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

  async append(key: string, data: Uint8Array): Promise<void> {
    const c = await this.client()
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    await c.multi().append(`${this.prefix}${key}`, buf).sAdd(this.indexKey, key).exec()
  }

  async write(key: string, data: Uint8Array): Promise<void> {
    const c = await this.client()
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    await c.multi().set(`${this.prefix}${key}`, buf).sAdd(this.indexKey, key).exec()
  }

  readAll(): Promise<Map<string, Uint8Array>> {
    return this.readMatching('')
  }

  async readMatching(suffix: string): Promise<Map<string, Uint8Array>> {
    const paths = (await this.indexedPaths()).filter((p) => p.endsWith(suffix))
    return this.readPaths(paths)
  }

  private async indexedPaths(): Promise<string[]> {
    const c = await this.client()
    const members = await c.sMembers(this.indexKey)
    return [...members].sort()
  }

  private async readPaths(paths: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    if (paths.length === 0) return out
    const c = await this.client()
    const mod = (await import('redis')) as unknown as {
      RESP_TYPES: { readonly BLOB_STRING: number }
    }
    const mapping: Record<number, unknown> = { [mod.RESP_TYPES.BLOB_STRING]: Buffer }
    const typed = c as unknown as {
      withTypeMapping: (m: Record<number, unknown>) => {
        mGet: (keys: string[]) => Promise<(Buffer | null)[]>
      }
    }
    const values = await typed.withTypeMapping(mapping).mGet(paths.map((p) => `${this.prefix}${p}`))
    paths.forEach((p, i) => {
      const raw = values[i]
      out.set(p, raw === null || raw === undefined ? new Uint8Array() : new Uint8Array(raw))
    })
    return out
  }

  async clear(): Promise<void> {
    const c = await this.client()
    const paths = await this.indexedPaths()
    const keys = [...paths.map((p) => `${this.prefix}${p}`), this.indexKey]
    if (keys.length > 0) await c.del(keys)
  }

  async close(): Promise<void> {
    // Idempotent: the workspace closes the plane store it consumed and the
    // owning WorkspaceStateStore closes every plane it built; the second
    // close must be a no-op, not a crash on an already-quit client.
    if (this.clientPromise === null) return
    const pending = this.clientPromise
    this.clientPromise = null
    const c = await pending
    await c.quit()
  }
}
