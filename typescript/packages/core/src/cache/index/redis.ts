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

import { toIsoZ } from '../../utils/dates.ts'
import { KeyLock } from '../lock.ts'
import { uuid7 } from '../../utils/ids.ts'
import { underPath } from '../../utils/key_prefix.ts'
import { loadOptionalPeer } from '../../utils/optional_peer.ts'
import { rstripSlash } from '../../utils/slash.ts'
import {
  IndexDirectorySchema,
  IndexEntry,
  LookupStatus,
  type IndexDirectory,
  type ListResult,
  type LookupResult,
} from './config.ts'
import { IndexCacheStore } from './store.ts'
import { CHILDREN_PREFIX, DEFAULT_KEY_PREFIX, ENTRY_PREFIX, GENERATION_KEY } from './constants.ts'

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
  set: (key: string, value: string, options?: { NX: boolean }) => RedisPipeline
  del: (key: string) => RedisPipeline
  exec: () => Promise<unknown>
}

export interface RedisClientLike {
  connect: () => Promise<unknown>
  get: (key: string) => Promise<string | null>
  mGet: (keys: string[]) => Promise<(string | null)[]>
  set: (key: string, value: string, options?: { NX: boolean }) => Promise<unknown>
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

// Directory records retain stale listings like RAM; Redis maxmemory eviction
// can still turn any cached fact into a miss.
export class RedisIndexCacheStore extends IndexCacheStore {
  private readonly ttl: number
  private readonly url: string
  private readonly providedClient: RedisClientLike | null
  private readonly entryPrefix: string
  private readonly childrenPrefix: string
  private readonly generationKey: string
  private readonly initializingGenerations = new Map<string, Promise<string>>()
  private clientPromise: Promise<RedisClientLike> | null = null

  private readonly seedLock = new KeyLock()
  private readonly pendingSeeds: {
    entries: Map<string, IndexEntry>
    children: Map<string, string[]>
    expiresAt: number
  }[] = []
  private closed = false

  constructor(options: RedisIndexCacheOptions = {}) {
    super()
    this.ttl = options.ttl ?? 600
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.providedClient = options.client ?? null
    const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.entryPrefix = `${prefix}${ENTRY_PREFIX}`
    this.childrenPrefix = `${prefix}${CHILDREN_PREFIX}`
    this.generationKey = `${prefix}${GENERATION_KEY}`
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

  seed(
    entries: ReadonlyMap<string, IndexEntry>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
  ): void {
    const nowIso = toIsoZ(new Date())
    this.pendingSeeds.push({
      entries: new Map(
        [...entries].map(([path, entry]) => [
          path,
          entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry,
        ]),
      ),
      children: new Map([...children].map(([path, keys]) => [path, [...keys]])),
      expiresAt: expiresAt.getTime() / 1000,
    })
  }

  private generation(c: RedisClientLike, key: string): Promise<string> {
    const pending = this.initializingGenerations.get(key)
    if (pending !== undefined) return pending
    // Parallel directory refills in this store share one global initializer.
    // Do not retain it afterwards: the next read must observe invalidations.
    const initialized = (async () => {
      const current = await c.get(key)
      if (current !== null) return current
      // A new token after eviction must never revive an old listing.
      const generation = uuid7()
      await c.set(key, generation, { NX: true })
      // Even when NX loses, keep our attempted token. A later read could adopt
      // a replacement written by an invalidation/refill and revive old data.
      return generation
    })().finally(() => {
      this.initializingGenerations.delete(key)
    })
    this.initializingGenerations.set(key, initialized)
    return initialized
  }

  private flushSeed(): Promise<void> {
    return this.seedLock.withLock('seed', async () => {
      while (this.pendingSeeds.length > 0) {
        const pending = [...this.pendingSeeds]
        const c = await this.client()
        const generation = await this.generation(c, this.generationKey)
        const directories = new Map<string, string>()
        const paths = [...new Set(pending.flatMap((seed) => [...seed.children.keys()]))]
        if (paths.length > 0) {
          const current = await c.mGet(paths.map((path) => `${this.generationKey}:${path}`))
          const missing = new Map<string, string>()
          // Keep observed tokens: rereading them after a concurrent invalidation
          // could stamp the pending snapshot with a replacement generation.
          for (const [i, path] of paths.entries()) {
            const token = current[i]
            if (token == null) missing.set(path, uuid7())
            else directories.set(path, token)
          }
          if (missing.size > 0) {
            const initialize = c.multi()
            for (const [path, token] of missing) {
              initialize.set(`${this.generationKey}:${path}`, token, { NX: true })
            }
            await initialize.exec()
            for (const [path, token] of missing) directories.set(path, token)
          }
        }
        const pipe = c.multi()
        for (const seed of pending) {
          for (const [path, entry] of seed.entries) {
            pipe.set(this.entryKey(path), JSON.stringify(entry))
          }
          for (const [path, keys] of seed.children) {
            const listing: IndexDirectory = {
              entries: keys,
              expires_at: seed.expiresAt,
              generation: `${generation}:${directories.get(path) ?? ''}`,
            }
            pipe.set(this.childrenKey(path), JSON.stringify(listing))
          }
        }
        await pipe.exec()
        this.pendingSeeds.splice(0, pending.length)
      }
    })
  }

  async entries(): Promise<Map<string, IndexEntry>> {
    await this.flushSeed()
    const c = await this.client()
    const entries = new Map<string, IndexEntry>()
    for await (const batch of c.scanIterator({ MATCH: `${globEscape(this.entryPrefix)}*` })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) {
        const raw = await c.get(key)
        if (raw !== null) entries.set(key.slice(this.entryPrefix.length), IndexEntry.fromJSON(raw))
      }
    }
    return entries
  }

  async get(vfsPath: string): Promise<LookupResult> {
    await this.flushSeed()
    const c = await this.client()
    const raw = await c.get(this.entryKey(vfsPath))
    if (raw === null) return { status: LookupStatus.NOT_FOUND }
    return { entry: IndexEntry.fromJSON(raw) }
  }

  async put(vfsPath: string, entry: IndexEntry): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    const stored =
      entry.indexTime === '' ? entry.copyWith({ indexTime: toIsoZ(new Date()) }) : entry
    await c.set(this.entryKey(vfsPath), JSON.stringify(stored))
  }

  async listDir(vfsPath: string): Promise<ListResult> {
    await this.flushSeed()
    const c = await this.client()
    const [raw, current, directory] = await c.mGet([
      this.childrenKey(vfsPath),
      this.generationKey,
      `${this.generationKey}:${vfsPath}`,
    ])
    if (raw == null) return { status: LookupStatus.NOT_FOUND }
    const listing = IndexDirectorySchema.parse(JSON.parse(raw))
    if (
      current == null ||
      directory == null ||
      listing.generation !== `${current}:${directory}` ||
      Date.now() / 1000 >= listing.expires_at
    )
      return { status: LookupStatus.EXPIRED }
    return { entries: listing.entries }
  }

  async setDir(
    vfsPath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    const now = new Date()
    const nowIso = toIsoZ(now)
    const prefix = vfsPath === '/' ? '/' : `${vfsPath}/`
    const generation = await this.generation(c, this.generationKey)
    const directory = await this.generation(c, `${this.generationKey}:${vfsPath}`)
    const pipe = c.multi()
    const childKeys: string[] = []
    for (const [name, entry] of entries) {
      const fullPath = prefix + name
      const stored = entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry
      pipe.set(this.entryKey(fullPath), JSON.stringify(stored))
      childKeys.push(fullPath)
    }
    const listing: IndexDirectory = {
      entries: childKeys,
      generation: `${generation}:${directory}`,
      expires_at: (expiredAt?.getTime() ?? now.getTime() + this.ttl * 1000) / 1000,
    }
    pipe.set(this.childrenKey(vfsPath), JSON.stringify(listing))
    await pipe.exec()
  }

  async invalidateDir(vfsPath: string): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    const raw = await c.get(this.childrenKey(vfsPath))
    const childPaths = raw === null ? [] : IndexDirectorySchema.parse(JSON.parse(raw)).entries
    const pipe = c.multi()
    for (const child of childPaths) {
      pipe.del(this.entryKey(child))
    }
    pipe.del(this.childrenKey(vfsPath))
    pipe.del(`${this.generationKey}:${vfsPath}`)
    await pipe.exec()
  }

  private async scanDelete(prefix: string, vfsPath: string): Promise<void> {
    const c = await this.client()
    const pattern = `${globEscape(prefix + rstripSlash(vfsPath))}*`
    const keys: string[] = []
    for await (const k of c.scanIterator({ MATCH: pattern })) {
      const batch = Array.isArray(k) ? k : [k]
      for (const key of batch) {
        const path = key.slice(prefix.length)
        if (underPath(path, vfsPath)) keys.push(key)
      }
    }
    if (keys.length > 0) await c.del(keys)
  }

  async invalidatePrefix(vfsPath: string): Promise<void> {
    await this.flushSeed()
    await this.scanDelete(this.entryPrefix, vfsPath)
    await this.scanDelete(this.childrenPrefix, vfsPath)
    await this.scanDelete(`${this.generationKey}:`, vfsPath)
  }

  async invalidate(): Promise<void> {
    await this.flushSeed()
    const c = await this.client()
    // Atomically expire listings without overwriting concurrent refills/deletions.
    await c.set(this.generationKey, uuid7())
  }

  clear(): Promise<void> {
    return this.seedLock.withLock('seed', async () => {
      this.pendingSeeds.length = 0
      await this.scanDelete(this.entryPrefix, '/')
      await this.scanDelete(this.childrenPrefix, '/')
      await this.scanDelete(`${this.generationKey}:`, '/')
      const c = await this.client()
      await c.del(this.generationKey)
    })
  }

  override async close(): Promise<void> {
    if (this.closed) return
    await this.flushSeed()
    if (this.providedClient === null && this.clientPromise !== null) {
      const c = await this.clientPromise
      const typed = c as unknown as { destroy?: () => void }
      if (typeof typed.destroy === 'function') typed.destroy()
      else if (c.isOpen) await c.quit()
      this.clientPromise = null
    }
    this.closed = true
  }
}
