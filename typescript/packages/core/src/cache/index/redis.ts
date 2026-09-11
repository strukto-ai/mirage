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

import { underPath } from '../../utils/key_prefix.ts'
import { loadOptionalPeer } from '../../utils/optional_peer.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { IndexEntry, LookupStatus, type ListResult, type LookupResult } from './config.ts'
import { IndexCacheStore } from './store.ts'

const ENTRY_PREFIX = 'mirage:idx:entry:'
const CHILDREN_PREFIX = 'mirage:idx:children:'
const DEFAULT_KEY_PREFIX = 'mirage:index:'

/**
 * Escape redis MATCH metacharacters in a literal path.
 *
 * A path may legally contain `*?[]`, and SCAN's pattern is a glob, so an
 * unescaped path would match keys it does not name. The escaping is a
 * narrowing optimization only; the caller still filters at a path boundary.
 * Mirrors Python `_glob_escape` (`cache/index/redis.py`).
 */
function globEscape(value: string): string {
  return value.replace(/[*?[\]\\]/g, (char) => `\\${char}`)
}

interface RedisPipeline {
  set: (key: string, value: string) => RedisPipeline
  del: (key: string) => RedisPipeline
  rPush: (key: string, values: string[]) => RedisPipeline
  expire: (key: string, seconds: number) => RedisPipeline
  exec: () => Promise<unknown>
}

export interface RedisClientLike {
  connect: () => Promise<unknown>
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<unknown>
  exists: (key: string) => Promise<number>
  ttl: (key: string) => Promise<number>
  lRange: (key: string, start: number, stop: number) => Promise<string[]>
  del: (key: string | string[]) => Promise<unknown>
  multi: () => RedisPipeline
  scanIterator: (options: { MATCH: string }) => AsyncIterable<string | string[]>
  isOpen: boolean
  quit: () => Promise<unknown>
}

export interface RedisIndexCacheOptions {
  ttl?: number
  url?: string
  client?: RedisClientLike
  keyPrefix?: string
}

export class RedisIndexCacheStore extends IndexCacheStore {
  private readonly ttl: number
  private readonly url: string
  private readonly providedClient: RedisClientLike | null
  private readonly entryPrefix: string
  private readonly childrenPrefix: string
  private clientPromise: Promise<RedisClientLike> | null = null

  constructor(options: RedisIndexCacheOptions = {}) {
    super()
    this.ttl = options.ttl ?? 600
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.providedClient = options.client ?? null
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.entryPrefix = `${prefix}${ENTRY_PREFIX}`
    this.childrenPrefix = `${prefix}${CHILDREN_PREFIX}`
  }

  private entryKey(path: string): string {
    return `${this.entryPrefix}${path}`
  }

  private childrenKey(path: string): string {
    return `${this.childrenPrefix}${path}`
  }

  private client(): Promise<RedisClientLike> {
    if (this.providedClient !== null) return Promise.resolve(this.providedClient)
    this.clientPromise ??= (async () => {
      const spec = 'redis'
      const mod = (await loadOptionalPeer(() => import(/* @vite-ignore */ spec), {
        feature: 'RedisIndexCacheStore',
        packageName: 'redis',
      })) as {
        createClient: (o: { url: string; socket?: unknown }) => RedisClientLike
      }
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      })
      await c.connect()
      return c
    })()
    return this.clientPromise
  }

  async get(resourcePath: string): Promise<LookupResult> {
    const c = await this.client()
    const raw = await c.get(this.entryKey(resourcePath))
    if (raw === null) return { status: LookupStatus.NOT_FOUND }
    const parsed = JSON.parse(raw) as {
      id: string
      name: string
      resourceType: string
      remoteTime?: string
      indexTime?: string
      vfsName?: string
      size?: number | null
      extra?: Record<string, unknown>
    }
    return { entry: new IndexEntry(parsed) }
  }

  async put(resourcePath: string, entry: IndexEntry): Promise<void> {
    const c = await this.client()
    const stored =
      entry.indexTime === '' ? entry.copyWith({ indexTime: new Date().toISOString() }) : entry
    await c.set(this.entryKey(resourcePath), JSON.stringify(this.serialize(stored)))
  }

  async listDir(resourcePath: string): Promise<ListResult> {
    const c = await this.client()
    const key = this.childrenKey(resourcePath)
    const exists = await c.exists(key)
    if (!exists) return { status: LookupStatus.NOT_FOUND }
    const ttlRemaining = await c.ttl(key)
    if (ttlRemaining === -2) return { status: LookupStatus.EXPIRED }
    const raw = await c.lRange(key, 0, -1)
    return { entries: [...raw] }
  }

  async setDir(
    resourcePath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    const c = await this.client()
    const now = new Date()
    const nowIso = now.toISOString()
    const prefix = resourcePath === '/' ? '/' : `${resourcePath}/`
    const pipe = c.multi()
    const childKeys: string[] = []
    for (const [name, entry] of entries) {
      const fullPath = prefix + name
      const stored = entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry
      pipe.set(this.entryKey(fullPath), JSON.stringify(this.serialize(stored)))
      childKeys.push(fullPath)
    }
    const childrenKey = this.childrenKey(resourcePath)
    pipe.del(childrenKey)
    if (childKeys.length > 0) {
      pipe.rPush(childrenKey, childKeys)
    }
    const ttlSeconds =
      expiredAt !== null && expiredAt !== undefined
        ? Math.max(1, Math.floor((expiredAt.getTime() - now.getTime()) / 1000))
        : Math.max(1, Math.floor(this.ttl))
    pipe.expire(childrenKey, ttlSeconds)
    await pipe.exec()
  }

  async invalidateDir(resourcePath: string): Promise<void> {
    const c = await this.client()
    const childPaths = await c.lRange(this.childrenKey(resourcePath), 0, -1)
    const pipe = c.multi()
    for (const child of childPaths) {
      pipe.del(this.entryKey(child))
    }
    pipe.del(this.childrenKey(resourcePath))
    await pipe.exec()
  }

  private async scanDelete(prefix: string, resourcePath: string): Promise<void> {
    const c = await this.client()
    const pattern = `${prefix}${globEscape(rstripSlash(resourcePath))}*`
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: pattern })) {
      const batch = Array.isArray(k) ? k : [k]
      for (const key of batch) {
        if (underPath(key.slice(prefix.length), resourcePath)) keys.push(key)
      }
    }
    if (keys.length > 0) await c.del(keys)
  }

  async invalidatePrefix(resourcePath: string): Promise<void> {
    await this.scanDelete(this.entryPrefix, resourcePath)
    await this.scanDelete(this.childrenPrefix, resourcePath)
  }

  // Clear rather than expire, because redis cannot say "stale" here. The RAM
  // store marks entries expired in place, so a later lookup answers EXPIRED
  // and a backend whose index *is* its listing knows to refetch. A redis key
  // carries a real TTL and an expired one is simply gone, so absent and stale
  // read the same. The consequence, deliberately chosen: a github mount on a
  // redis index answers ENOENT after a CLI write instead of refetching. That
  // is a loud failure, not a wrong answer -- a no-op here would instead serve
  // the pre-write tree as if it were current, and quietly wrong is the worse
  // of the two. Closing this properly means an `invalidatedAt` marker key
  // compared against each entry's indexTime, which needs no schema change and
  // can ride the same round trip.
  async invalidate(): Promise<void> {
    await this.clear()
  }

  async clear(): Promise<void> {
    const c = await this.client()
    for (const pattern of [`${this.entryPrefix}*`, `${this.childrenPrefix}*`]) {
      const keys: string[] = []
      for await (const k of c.scanIterator({ MATCH: pattern })) {
        if (Array.isArray(k)) keys.push(...k)
        else keys.push(k)
      }
      if (keys.length > 0) await c.del(keys)
    }
  }

  override async close(): Promise<void> {
    if (this.providedClient !== null) return
    if (this.clientPromise === null) return
    const c = await this.clientPromise
    const typed = c as unknown as { destroy?: () => void }
    if (typeof typed.destroy === 'function') typed.destroy()
    else if (c.isOpen) await c.quit()
    this.clientPromise = null
  }

  private serialize(e: IndexEntry): Record<string, unknown> {
    return {
      id: e.id,
      name: e.name,
      resourceType: e.resourceType,
      remoteTime: e.remoteTime,
      indexTime: e.indexTime,
      vfsName: e.vfsName,
      size: e.size,
      extra: e.extra,
    }
  }
}
