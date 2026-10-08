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

import { underPath } from '@struktoai/mirage-core/utils/key_prefix'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { CacheType } from '@struktoai/mirage-core/cache/file/config'
import { Invalidation } from '@struktoai/mirage-core/cache/invalidation'
import { validateMaxDrainBytes } from '@struktoai/mirage-core/cache/file/mixin'
import type { FileCache } from '@struktoai/mirage-core/cache/file/mixin'
import { globEscape, parseLimit, tokenOrNull } from '@struktoai/mirage-core/cache/file/utils'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { registerFileCacheStore } from '@struktoai/mirage-core/workspace/workspace/cache'
import type { RedisClientType } from 'redis'
import { RedisVFS, type RedisVFSOptions } from '../../vfs/redis/redis.ts'

// Shipped next to this module and copied beside it into dist; byte-identical
// to the Python version.lua. By hash, so sent whole: the same SHA Python's
// registered script carries.
const VERSION_LUA = readFileSync(new URL('./version.lua', import.meta.url), 'utf8')
const VERSION_SHA = createHash('sha1').update(VERSION_LUA).digest('hex')

/** Whether a pipeline failed because the server had no script for a hash. */
function noScript(err: unknown): boolean {
  const replies = (err as { replies?: unknown[] } | null)?.replies ?? [err]
  return replies.some((reply) => reply instanceof Error && reply.message.startsWith('NOSCRIPT'))
}

// Hash slots one SCAN call visits. A prefix drop walks the whole server,
// so this sets both the round trips (dbsize / SCAN_COUNT) and how long
// each call holds the server: about 1-2 ms at 1000, against the 10 ms
// slowlog default. The client default of 10 made one drop at 1M server
// keys take 191k round trips.
const SCAN_COUNT = 1000

// Keys one DEL names. Freeing memory is what a DEL costs, and a body has no
// size bound: one DEL per page freed up to SCAN_COUNT bodies at once, about
// 10 ms for 100 bodies of 512 KB and 1.5 ms for 10. A page goes out as one
// pipeline of DELs this size, so it is still one round trip.
export const DEL_BATCH = 10

// Keys per MGET of versions and per pipeline of kept versions.
export const KEY_BATCH = 1000

// Seconds a version kept without its bytes lives (raise-only over bytes).
export const VERSION_TTL = 86_400

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

export interface RedisFileCacheOptions extends RedisVFSOptions {
  cacheLimit?: string | number
  maxDrainBytes?: number | null
}

export class RedisFileCacheStore extends RedisVFS implements FileCache {
  // Advisory only: unlike the RAM store there is no client-side LRU, so
  // nothing evicts on overflow. Cap memory on the Redis server instead
  // (maxmemory + maxmemory-policy allkeys-lru) to approximate the RAM
  // store's eviction behavior.
  private readonly limit: number
  private readonly dataPrefix: string
  private readonly metaPrefix: string
  private readonly entryPattern: string
  private readonly entryBases: readonly string[]
  private maxDrainBytesValue: number | null = null
  // Local invalidation also discards fills paused in cooperative hashing.
  private readonly invalidation = new Invalidation()

  constructor(options: RedisFileCacheOptions = {}) {
    super({
      url: options.url ?? 'redis://localhost:6379/0',
      keyPrefix: options.keyPrefix ?? 'mirage:cache:',
    })
    this.limit = parseLimit(options.cacheLimit ?? '512MB')
    this.dataPrefix = `${this.keyPrefix}data:`
    this.metaPrefix = `${this.keyPrefix}meta:`
    this.entryPattern = `${globEscape(this.keyPrefix)}[dm][ae]ta:`
    this.entryBases = [this.dataPrefix, this.metaPrefix].map((p) => RedisFileCacheStore.asBytes(p))
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

  // The cache's own key test, part of `FileCache` and not a driver verb:
  // the key is the cache entry's, not a path the mount resolves.
  override async exists(key: string | PathSpec): Promise<boolean> {
    const k = typeof key === 'string' ? key : key.mountPath
    const c = await this.cacheClient()
    return (await c.exists(this.dataKey(k))) > 0
  }
  /**
   * The cache client with every bulk string read as raw bytes: a body is
   * binary, and a key whose name is not UTF-8 keeps its exact bytes.
   */
  private async bytesView(): Promise<{
    get: (k: string) => Promise<Buffer | null>
    scan: (
      cursor: string,
      options: { MATCH: string; COUNT: number },
    ) => Promise<{ cursor: Buffer | string; keys: Buffer[] }>
  }> {
    const c = await this.cacheClient()
    const mod = await this.module()
    const typed = c as unknown as {
      withTypeMapping: (
        m: Record<number, unknown>,
      ) => Awaited<ReturnType<RedisFileCacheStore['bytesView']>>
    }
    return typed.withTypeMapping({ [mod.RESP_TYPES.BLOB_STRING]: Buffer })
  }

  async get(key: string): Promise<Uint8Array | null> {
    const raw = await (await this.bytesView()).get(this.dataKey(key))
    if (raw === null) return null
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }

  async set(
    key: string,
    data: Uint8Array,
    options: { fingerprint?: string | null; ttl?: number | null } = {},
  ): Promise<void> {
    const stamp = this.invalidation.enter(key)
    try {
      const fp = tokenOrNull(options.fingerprint)
      const c = await this.cacheClient()
      if (this.invalidation.stale(key, stamp)) return
      const dk = this.dataKey(key)
      const mk = this.metaKey(key)
      const pipe = c.multi()
      pipe.set(dk, toBuffer(data))
      // Deleted, not left alone: redis expires the two keys independently
      // and a re-set of an entry that carried a token would otherwise
      // leave the old meta key describing the new bytes, which isFresh
      // would read as fresh.
      if (fp !== null) pipe.set(mk, fp)
      else pipe.del(mk)
      if (options.ttl !== null && options.ttl !== undefined) {
        pipe.expire(dk, options.ttl)
        if (fp !== null) pipe.expire(mk, options.ttl)
      }
      await pipe.exec()
    } finally {
      this.invalidation.leave(key)
    }
  }

  async remove(key: string): Promise<void> {
    this.invalidation.invalidate(key)
    const c = await this.cacheClient()
    const pipe = c.multi()
    pipe.del(this.dataKey(key))
    pipe.del(this.metaKey(key))
    await pipe.exec()
  }
  async fingerprint(key: string): Promise<string | null> {
    const c = await this.cacheClient()
    return await c.get(this.metaKey(key))
  }

  async fingerprints(keys: readonly string[]): Promise<(string | null)[]> {
    const c = await this.cacheClient()
    const out: (string | null)[] = []
    for (let start = 0; start < keys.length; start += KEY_BATCH) {
      const batch = keys.slice(start, start + KEY_BATCH).map((k) => this.metaKey(k))
      out.push(...(await c.mGet(batch)))
    }
    return out
  }

  async keepFingerprints(fingerprints: Readonly<Record<string, string>>): Promise<void> {
    const keys = Object.keys(fingerprints)
    for (let start = 0; start < keys.length; start += KEY_BATCH) {
      const batch = keys.slice(start, start + KEY_BATCH)
      const stamps = batch.map((key) => [key, this.invalidation.enter(key)] as const)
      try {
        const c = await this.cacheClient()
        // Judged at each send: a retry after a script load runs later.
        const live = (): typeof stamps =>
          stamps.filter(([key, stamp]) => !this.invalidation.stale(key, stamp))
        if (live().length > 0) {
          const send = async (): Promise<void> => {
            const pipe = c.multi()
            for (const [key] of live()) {
              const fingerprint = fingerprints[key]
              if (fingerprint === undefined) continue
              pipe.evalSha(VERSION_SHA, {
                keys: [this.dataKey(key), this.metaKey(key)],
                arguments: [fingerprint, String(VERSION_TTL)],
              })
            }
            await pipe.execAsPipeline()
          }
          // A flushed script cache loads it once; the batch is idempotent.
          try {
            await send()
          } catch (err) {
            if (!noScript(err)) throw err
            await c.scriptLoad(VERSION_LUA)
            await send()
          }
        }
      } finally {
        for (const key of batch) this.invalidation.leave(key)
      }
    }
  }

  async isFresh(key: string, remoteFingerprint: string): Promise<boolean> {
    const c = await this.cacheClient()
    const [held, fp] = (await c
      .multi()
      .exists(this.dataKey(key))
      .get(this.metaKey(key))
      .execAsPipeline()) as unknown as [number, string | null]
    // A version kept without its bytes vouches for no bytes.
    if (held === 0 || fp === null) return false
    return fp === remoteFingerprint
  }

  async isUnbounded(key: string): Promise<boolean> {
    // Redis answers this natively and distinguishes the two cases that
    // matter: -1 is present with no expiry, -2 is absent.
    const c = await this.cacheClient()
    return (await c.ttl(this.dataKey(key))) === -1
  }

  async evictPrefix(prefix: string, excluded: readonly string[] = []): Promise<void> {
    this.invalidation.invalidatePrefix(prefix, excluded)
    await this.dropMatching(prefix, excluded)
  }

  /**
   * Delete the data and meta keys of every entry under `prefix`.
   *
   * One SCAN pass covers both kinds, and each page is deleted as it
   * arrives, in DELs of at most `DEL_BATCH` keys, so no single call holds
   * the server for the whole subtree.
   * Deleting keys a SCAN already returned is safe: SCAN still returns
   * every key present for the whole iteration.
   *
   * Keys arrive as bytes: node-redis decodes a string reply as UTF-8, and a
   * name with invalid bytes would come back as a different key. The loop is
   * by hand because scanIterator compares the cursor to '0' and never ends
   * once the cursor arrives as bytes too.
   */
  private async dropMatching(prefix: string, excluded: readonly string[] = []): Promise<void> {
    const c = await this.cacheClient()
    const bytes = await this.bytesView()
    const match = `${this.entryPattern}${globEscape(prefix)}*`
    const excludedBytes = excluded.map((root) => RedisFileCacheStore.asBytes(root))
    let cursor = '0'
    do {
      const reply = await bytes.scan(cursor, { MATCH: match, COUNT: SCAN_COUNT })
      cursor = reply.cursor.toString()
      const doomed = reply.keys.filter((k) => this.owned(k, excludedBytes))
      if (doomed.length === 0) continue
      const pipe = c.multi()
      for (let start = 0; start < doomed.length; start += DEL_BATCH)
        pipe.del(doomed.slice(start, start + DEL_BATCH))
      await pipe.execAsPipeline()
    } while (cursor !== '0')
  }

  /**
   * Each byte of `text` as one character, so prefix and boundary tests
   * compare the raw bytes of a key, the way Python compares its
   * surrogate-escaped name.
   */
  private static asBytes(text: string): string {
    return Buffer.from(text, 'utf8').toString('latin1')
  }

  /**
   * Whether a SCAN match is this cache's entry and not under an excluded
   * root, compared byte for byte (`excluded` already in byte form). The
   * MATCH class `[dm][ae]ta:` also admits `deta:` and `mata:`, which are
   * not the cache's.
   */
  private owned(raw: Buffer, excluded: readonly string[]): boolean {
    const name = raw.toString('latin1')
    for (const base of this.entryBases) {
      if (name.startsWith(base)) {
        const key = name.slice(base.length)
        return !excluded.some((boundary) => underPath(key, boundary))
      }
    }
    return false
  }

  evictPaths(_paths: Iterable<string>): void {
    // No-op: the redis cache holds nothing restored from a snapshot
    // (only RAM caches are repopulated at load), and the load path is
    // sync so a redis delete cannot be awaited here. To drop live
    // redis-cached entries, call `remove(key)` per path from an async
    // context. Mirrors Python `RedisFileCacheStore.evict_paths`.
  }

  async clear(): Promise<void> {
    this.invalidation.invalidateAll()
    await this.dropMatching('')
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
