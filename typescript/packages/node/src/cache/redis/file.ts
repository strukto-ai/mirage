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
  type FileCache,
  defaultFingerprint,
  parseLimit,
  type PathSpec,
} from '@struktoai/mirage-core'
import type { RedisClientType } from 'redis'
import { RedisResource, type RedisResourceOptions } from '../../resource/redis/redis.ts'

export interface RedisFileCacheOptions extends RedisResourceOptions {
  cacheLimit?: string | number
  maxDrainBytes?: number | null
}

export class RedisFileCacheStore extends RedisResource implements FileCache {
  private readonly limit: number
  private readonly dataPrefix: string
  private readonly metaPrefix: string
  maxDrainBytes: number | null

  constructor(options: RedisFileCacheOptions = {}) {
    super({
      url: options.url ?? 'redis://localhost:6379/0',
      keyPrefix: options.keyPrefix ?? 'mirage:cache:',
    })
    this.limit = parseLimit(options.cacheLimit ?? '512MB')
    this.dataPrefix = `${this.keyPrefix}data:`
    this.metaPrefix = `${this.keyPrefix}meta:`
    this.maxDrainBytes = options.maxDrainBytes ?? null
  }

  readonly cacheSize = 0

  get cacheLimit(): number {
    return this.limit
  }

  cacheClient(): Promise<RedisClientType> {
    return this.store.client()
  }

  async get(key: string): Promise<Uint8Array | null> {
    const c = await this.cacheClient()
    const mod = await this.module()
    const blob = mod.RESP_TYPES.BLOB_STRING
    const mapping: Record<number, unknown> = { [blob]: Buffer }
    const typed = c as unknown as {
      withTypeMapping: (m: Record<number, unknown>) => {
        get: (k: string) => Promise<Buffer | null>
      }
    }
    const raw = await typed.withTypeMapping(mapping).get(`${this.dataPrefix}${key}`)
    if (raw === null) return null
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }

  async set(
    key: string,
    data: Uint8Array,
    options: { fingerprint?: string | null; ttl?: number | null } = {},
  ): Promise<void> {
    const fp = options.fingerprint ?? defaultFingerprint(data)
    const c = await this.cacheClient()
    const dk = `${this.dataPrefix}${key}`
    const mk = `${this.metaPrefix}${key}`
    const pipe = c.multi()
    pipe.set(dk, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    pipe.set(mk, fp)
    if (options.ttl !== null && options.ttl !== undefined) {
      pipe.expire(dk, options.ttl)
      pipe.expire(mk, options.ttl)
    }
    await pipe.exec()
  }

  async add(
    key: string,
    data: Uint8Array,
    options: { fingerprint?: string | null; ttl?: number | null } = {},
  ): Promise<boolean> {
    const c = await this.cacheClient()
    const exists = await c.exists(`${this.dataPrefix}${key}`)
    if (exists) return false
    await this.set(key, data, options)
    return true
  }

  async remove(key: string): Promise<void> {
    const c = await this.cacheClient()
    const pipe = c.multi()
    pipe.del(`${this.dataPrefix}${key}`)
    pipe.del(`${this.metaPrefix}${key}`)
    await pipe.exec()
  }

  async exists(key: string | PathSpec): Promise<boolean> {
    const k = typeof key === 'string' ? key : key.mountPath
    const c = await this.cacheClient()
    return (await c.exists(`${this.dataPrefix}${k}`)) > 0
  }

  async isFresh(key: string, remoteFingerprint: string): Promise<boolean> {
    const c = await this.cacheClient()
    const fp = await c.get(`${this.metaPrefix}${key}`)
    if (fp === null) return false
    return fp === remoteFingerprint
  }

  async clear(): Promise<void> {
    const c = await this.cacheClient()
    for (const pattern of [`${this.dataPrefix}*`, `${this.metaPrefix}*`]) {
      const batch: string[] = []
      for await (const k of c.scanIterator({ MATCH: pattern })) {
        if (Array.isArray(k)) batch.push(...k)
        else batch.push(k)
      }
      if (batch.length > 0) await c.del(batch)
    }
  }

  async allCached(keys: readonly string[]): Promise<boolean> {
    for (const k of keys) {
      if (!(await this.exists(k))) return false
    }
    return true
  }

  async multiGet(keys: readonly string[]): Promise<(Uint8Array | null)[]> {
    const out: (Uint8Array | null)[] = []
    for (const k of keys) out.push(await this.get(k))
    return out
  }
}
