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
import { loadOptionalPeer } from '../../optional_peer.ts'

export interface RedisStoreOptions {
  url?: string
  client?: RedisClientType
  keyPrefix?: string
}

export class RedisStore {
  readonly url: string
  readonly keyPrefix: string
  private readonly providedClient: RedisClientType | null
  private clientPromise: Promise<RedisClientType> | null = null

  constructor(options: RedisStoreOptions = {}) {
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.keyPrefix = options.keyPrefix ?? 'mirage:fs:'
    this.providedClient = options.client ?? null
  }

  fk(path: string): string {
    return `${this.keyPrefix}file:${path}`
  }

  dk(): string {
    return `${this.keyPrefix}dir`
  }

  mk(path: string): string {
    return `${this.keyPrefix}modified:${path}`
  }

  async client(): Promise<RedisClientType> {
    if (this.providedClient !== null) return this.providedClient
    this.clientPromise ??= (async () => {
      const mod = await loadOptionalPeer(
        () =>
          import('redis') as unknown as Promise<{
            createClient: (o: { url: string }) => RedisClientType
          }>,
        { feature: 'RedisResource / RedisFileCacheStore', packageName: 'redis' },
      )
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      } as Parameters<typeof mod.createClient>[0])
      await c.connect()
      await c.sAdd(this.dk(), '/')
      return c
    })()
    return this.clientPromise
  }

  async getFile(path: string): Promise<Uint8Array | null> {
    const c = await this.client()
    const typed = c as unknown as {
      withTypeMapping: (m: Record<number, unknown>) => {
        get: (k: string) => Promise<Buffer | null>
      }
    }
    const mod = (await import('redis')) as unknown as {
      RESP_TYPES: { readonly BLOB_STRING: number }
    }
    const blob = mod.RESP_TYPES.BLOB_STRING
    const mapping: Record<number, unknown> = { [blob]: Buffer }
    const raw = await typed.withTypeMapping(mapping).get(this.fk(path))
    if (raw === null) return null
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }

  async setFile(path: string, data: Uint8Array): Promise<void> {
    const c = await this.client()
    await c.set(this.fk(path), Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  }

  async delFile(path: string): Promise<void> {
    const c = await this.client()
    await c.del(this.fk(path))
  }

  async hasFile(path: string): Promise<boolean> {
    const c = await this.client()
    return (await c.exists(this.fk(path))) > 0
  }

  async listFiles(prefix = ''): Promise<string[]> {
    const c = await this.client()
    const pattern = `${this.keyPrefix}file:${prefix}*`
    const strip = `${this.keyPrefix}file:`.length
    const result: string[] = []
    for await (const k of c.scanIterator({ MATCH: pattern })) {
      const keys = Array.isArray(k) ? k : [k]
      for (const key of keys) result.push(key.slice(strip))
    }
    return result.sort()
  }

  async fileLen(path: string): Promise<number> {
    const c = await this.client()
    return c.strLen(this.fk(path))
  }

  async hasDir(path: string): Promise<boolean> {
    const c = await this.client()
    return (await c.sIsMember(this.dk(), path)) === 1
  }

  async addDir(path: string): Promise<void> {
    const c = await this.client()
    await c.sAdd(this.dk(), path)
  }

  async removeDir(path: string): Promise<void> {
    const c = await this.client()
    await c.sRem(this.dk(), path)
  }

  async listDirs(): Promise<Set<string>> {
    const c = await this.client()
    const members = await c.sMembers(this.dk())
    return new Set(members)
  }

  async getModified(path: string): Promise<string | null> {
    const c = await this.client()
    return c.get(this.mk(path))
  }

  async setModified(path: string, ts: string): Promise<void> {
    const c = await this.client()
    await c.set(this.mk(path), ts)
  }

  async delModified(path: string): Promise<void> {
    const c = await this.client()
    await c.del(this.mk(path))
  }

  async clear(): Promise<void> {
    const c = await this.client()
    for (const pattern of [`${this.keyPrefix}file:*`, `${this.keyPrefix}modified:*`]) {
      const keys: string[] = []
      for await (const k of c.scanIterator({ MATCH: pattern })) {
        if (Array.isArray(k)) keys.push(...k)
        else keys.push(k)
      }
      if (keys.length > 0) await c.del(keys)
    }
    await c.del(this.dk())
  }

  async close(): Promise<void> {
    if (this.providedClient !== null) return
    if (this.clientPromise === null) return
    const c = await this.clientPromise
    const typed = c as unknown as { destroy?: () => void }
    if (typeof typed.destroy === 'function') typed.destroy()
    else if (c.isOpen) await c.quit()
    this.clientPromise = null
  }
}
