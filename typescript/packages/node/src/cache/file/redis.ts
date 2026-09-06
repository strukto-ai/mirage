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

import './utils.ts'

import { readFileSync } from 'node:fs'
import { CacheType } from '@struktoai/mirage-core/cache/file/config'
import { validateMaxDrainBytes } from '@struktoai/mirage-core/cache/file/mixin'
import type { FileCache } from '@struktoai/mirage-core/cache/file/mixin'
import {
  defaultFingerprintAsync,
  globEscape,
  parseLimit,
} from '@struktoai/mirage-core/cache/file/utils'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { registerFileCacheStore } from '@struktoai/mirage-core/workspace/workspace/cache'
import type { RedisClientType } from 'redis'
import { RedisResource, type RedisResourceOptions } from '../../resource/redis/redis.ts'

// Shipped next to this module in src and copied beside the bundle in
// dist (tsup onSuccess); byte-identical to the Python add.lua.
const ADD_LUA = readFileSync(new URL('./add.lua', import.meta.url), 'utf8')

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

export interface RedisFileCacheOptions extends RedisResourceOptions {
  cacheLimit?: string | number
  maxDrainBytes?: number | null
}

export class RedisFileCacheStore extends RedisResource implements FileCache {
  // Advisory only: unlike the RAM store there is no client-side LRU, so
  // nothing evicts on overflow. Cap memory on the Redis server instead
  // (maxmemory + maxmemory-policy allkeys-lru) to approximate the RAM
  // store's eviction behavior.
  private readonly limit: number
  private readonly dataPrefix: string
  private readonly metaPrefix: string
  private maxDrainBytesValue: number | null = null
  // Local invalidation also discards fills paused in cooperative hashing.
  private invalidationVersion = 0
  readonly drainTasks = new Map<string, Promise<void>>()

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

  get maxDrainBytes(): number | null {
    return this.maxDrainBytesValue
  }

  set maxDrainBytes(value: number | null) {
    validateMaxDrainBytes(this.limit, value)
    this.maxDrainBytesValue = value
  }

  // Size lives in the redis server and is not tracked client-side.
  readonly cacheSize: number | null = null
  readonly cacheEntries: number | null = null

  get cacheLimit(): number {
    return this.limit
  }

  cacheClient(): Promise<RedisClientType> {
    return this.store.client()
  }

  private dataKey(key: string): string {
    return `${this.dataPrefix}${key}`
  }

  private metaKey(key: string): string {
    return `${this.metaPrefix}${key}`
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
    const raw = await typed.withTypeMapping(mapping).get(this.dataKey(key))
    if (raw === null) return null
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }

  async set(
    key: string,
    data: Uint8Array,
    options: { fingerprint?: string | null; ttl?: number | null } = {},
  ): Promise<void> {
    const version = this.invalidationVersion
    const fp = options.fingerprint ?? (await defaultFingerprintAsync(data))
    const c = await this.cacheClient()
    if (version !== this.invalidationVersion) return
    const dk = this.dataKey(key)
    const mk = this.metaKey(key)
    const pipe = c.multi()
    pipe.set(dk, toBuffer(data))
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
    const version = this.invalidationVersion
    const c = await this.cacheClient()
    const fp = options.fingerprint ?? (await defaultFingerprintAsync(data))
    if (version !== this.invalidationVersion) return false
    // A background drain is insert-only: an older drain finishing late must
    // not overwrite a newer cache fill. add.lua keeps the check, bytes,
    // fingerprint and TTL in one execution so writers cannot interleave.
    const inserted = await c.eval(ADD_LUA, {
      keys: [this.dataKey(key), this.metaKey(key)],
      arguments: [
        toBuffer(data),
        fp,
        options.ttl === null || options.ttl === undefined ? '' : String(options.ttl),
      ],
    })
    return inserted === 1
  }

  async remove(key: string): Promise<void> {
    this.invalidationVersion++
    // Promises cannot be cancelled: dropping the map entry makes the
    // pending backgroundDrain skip its cache fill, mirroring the RAM
    // store's task cancel.
    this.drainTasks.delete(key)
    const c = await this.cacheClient()
    const pipe = c.multi()
    pipe.del(this.dataKey(key))
    pipe.del(this.metaKey(key))
    await pipe.exec()
  }

  override async exists(key: string | PathSpec): Promise<boolean> {
    const k = typeof key === 'string' ? key : key.mountPath
    const c = await this.cacheClient()
    return (await c.exists(this.dataKey(k))) > 0
  }

  async isFresh(key: string, remoteFingerprint: string): Promise<boolean> {
    const c = await this.cacheClient()
    const fp = await c.get(this.metaKey(key))
    if (fp === null) return false
    return fp === remoteFingerprint
  }

  async evictPrefix(prefix: string): Promise<void> {
    this.invalidationVersion++
    for (const key of [...this.drainTasks.keys()]) {
      if (key.startsWith(prefix)) this.drainTasks.delete(key)
    }
    const escaped = globEscape(prefix)
    const c = await this.cacheClient()
    for (const base of [this.dataPrefix, this.metaPrefix]) {
      const batch: string[] = []
      for await (const k of c.scanIterator({ MATCH: `${base}${escaped}*` })) {
        if (Array.isArray(k)) batch.push(...k)
        else batch.push(k)
      }
      if (batch.length > 0) await c.del(batch)
    }
  }

  evictPaths(_paths: Iterable<string>): void {
    // No-op: the redis cache holds nothing restored from a snapshot
    // (only RAM caches are repopulated at load), and the load path is
    // sync so a redis delete cannot be awaited here. To drop live
    // redis-cached entries, call `remove(key)` per path from an async
    // context. Mirrors Python `RedisFileCacheStore.evict_paths`.
  }

  async clear(): Promise<void> {
    this.invalidationVersion++
    this.drainTasks.clear()
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

  async multiGet(keys: readonly string[]): Promise<(Uint8Array | null)[]> {
    const out: (Uint8Array | null)[] = []
    for (const k of keys) out.push(await this.get(k))
    return out
  }
}

// Registered on import so a declarative `cache: {type: redis}` resolves
// here: core owns buildFileCache but cannot import this package. Same
// seam the runtimes use (`registerRuntime`).
registerFileCacheStore(CacheType.REDIS, (config) => {
  return new RedisFileCacheStore({
    ...(config.limit !== undefined ? { cacheLimit: config.limit } : {}),
    ...(config.maxDrainBytes !== undefined ? { maxDrainBytes: config.maxDrainBytes } : {}),
    ...(config.url !== undefined ? { url: config.url } : {}),
    ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
  })
})
