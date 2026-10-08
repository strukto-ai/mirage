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
import { RAMVFS } from '../../vfs/ram/ram.ts'
import type { PathSpec } from '../../types.ts'
import { Invalidation } from '../invalidation.ts'
import { KeyLock } from '../lock.ts'
import { CacheEntry, Holds } from './entry.ts'
import { type FileCache, validateMaxDrainBytes } from './mixin.ts'
import { parseLimit, tokenOrNull } from './utils.ts'

export class RAMFileCacheStore extends RAMVFS implements FileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly lock = new KeyLock()
  private readonly limit: number
  private size = 0
  private readonly invalidation = new Invalidation()
  private maxDrainBytesValue: number | null = null

  constructor(options: { limit?: string | number; maxDrainBytes?: number | null } = {}) {
    super()
    this.limit = parseLimit(options.limit ?? '512MB')
    this.maxDrainBytes = options.maxDrainBytes ?? null
  }

  get maxDrainBytes(): number | null {
    return this.maxDrainBytesValue
  }

  set maxDrainBytes(value: number | null) {
    validateMaxDrainBytes(this.limit, value)
    this.maxDrainBytesValue = value
  }

  get cacheSize(): number {
    return this.size
  }

  get cacheEntries(): number {
    return this.entries.size
  }

  get cacheLimit(): number {
    return this.limit
  }

  snapshotEntries(): { key: string; entry: CacheEntry }[] {
    return [...this.entries.entries()].map(([key, entry]) => ({ key, entry }))
  }

  loadEntry(key: string, data: Uint8Array, entry: CacheEntry): void {
    this.store.files.set(key, data)
    this.entries.set(key, entry)
    this.size += entry.size
  }

  async get(key: string): Promise<Uint8Array | null> {
    // The data, and whether an expiry left a version to evict around.
    const [data, kept] = await this.lock.withLock(
      key,
      (): Promise<[Uint8Array | null, boolean]> => {
        const entry = this.entries.get(key)
        if (!entry?.hasBytes) return Promise.resolve([null, false])
        if (entry.expired) {
          this.dropEntry(key)
          // A kept version outlives its bytes, as redis's meta key does.
          if (
            entry.holds === Holds.BYTES_AND_VERSION &&
            entry.fingerprint !== null &&
            entry.fingerprint !== ''
          ) {
            this.putVersion(key, entry.fingerprint)
            return Promise.resolve([null, true])
          }
          return Promise.resolve([null, false])
        }
        this.entries.delete(key)
        this.entries.set(key, entry)
        return Promise.resolve([this.store.files.get(key) ?? null, false])
      },
    )
    if (kept) await this.evict()
    return data
  }

  // The cache's own key test, part of `FileCache` and not a driver verb:
  // the key is the cache entry's, not a path the mount resolves.
  override exists(key: string | PathSpec): Promise<boolean> {
    const k = typeof key === 'string' ? key : key.mountPath
    const entry = this.entries.get(k)
    return Promise.resolve(entry !== undefined && entry.hasBytes && !entry.expired)
  }
  async set(
    key: string,
    data: Uint8Array,
    options: { fingerprint?: string | null; ttl?: number | null } = {},
  ): Promise<void> {
    // Stamped before waiting on the lock: bytes read before an
    // invalidation are stale even when the lock was granted after it.
    const stamp = this.invalidation.enter(key)
    try {
      await this.lock.withLock(key, async () => {
        if (this.invalidation.stale(key, stamp)) return
        this.dropEntry(key)
        const entry = new CacheEntry({
          size: data.byteLength,
          cachedAt: Math.floor(Date.now() / 1000),
          fingerprint: tokenOrNull(options.fingerprint),
          ttl: options.ttl ?? null,
        })
        this.entries.set(key, entry)
        this.store.files.set(key, data)
        this.size += entry.size
        return Promise.resolve()
      })
    } finally {
      this.invalidation.leave(key)
    }
    await this.evict()
  }

  async evictPrefix(prefix: string, excluded: readonly string[] = []): Promise<void> {
    // Before the removals below: a fill in flight under the prefix has no
    // entry yet, so only its registration can name it.
    this.invalidation.invalidatePrefix(prefix, excluded)
    const keys = [...this.entries.keys()].filter(
      (k) => k.startsWith(prefix) && !excluded.some((boundary) => underPath(k, boundary)),
    )
    for (const key of keys) await this.remove(key)
  }

  evictPaths(paths: Iterable<string>): void {
    for (const key of paths) {
      this.invalidation.invalidate(key)
      this.dropEntry(key)
    }
  }

  remove(key: string): Promise<void> {
    return this.lock.withLock(key, () => {
      // Advanced here, when the removal takes effect, not when it was
      // called: a writer queued behind it took its stamp before this ran,
      // and only a later invalidation tells it its bytes predate the
      // removal. Per key: a fill of another key still hashing is not this
      // removal's business.
      this.invalidation.invalidate(key)
      this.dropEntry(key)
      this.lock.discard(key)
      return Promise.resolve()
    })
  }
  fingerprint(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key)?.fingerprint ?? null)
  }
  fingerprints(keys: readonly string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((key) => this.entries.get(key)?.fingerprint ?? null))
  }
  async keepFingerprints(fingerprints: Readonly<Record<string, string>>): Promise<void> {
    for (const [key, fingerprint] of Object.entries(fingerprints)) {
      await this.setVersion(key, fingerprint)
    }
  }

  private async setVersion(key: string, fingerprint: string): Promise<void> {
    const stamp = this.invalidation.enter(key)
    try {
      await this.lock.withLock(key, () => {
        if (this.invalidation.stale(key, stamp)) return Promise.resolve()
        const entry = this.entries.get(key)
        if (entry !== undefined && entry.hasBytes && !entry.expired) {
          if (entry.fingerprint === fingerprint) {
            this.entries.set(
              key,
              new CacheEntry({
                size: entry.size,
                cachedAt: entry.cachedAt,
                fingerprint: entry.fingerprint,
                ttl: entry.ttl,
                holds: Holds.BYTES_AND_VERSION,
              }),
            )
          }
          return Promise.resolve()
        }
        this.dropEntry(key)
        this.putVersion(key, fingerprint)
        return Promise.resolve()
      })
    } finally {
      this.invalidation.leave(key)
    }
    await this.evict()
  }

  private dropEntry(key: string): void {
    const entry = this.entries.get(key)
    if (entry !== undefined) {
      this.size -= entry.size
      this.entries.delete(key)
    }
    this.store.files.delete(key)
  }

  private putVersion(key: string, fingerprint: string): void {
    const version = new CacheEntry({
      size: key.length + fingerprint.length,
      cachedAt: Math.floor(Date.now() / 1000),
      fingerprint,
      holds: Holds.VERSION,
    })
    this.entries.set(key, version)
    this.size += version.size
  }

  isFresh(key: string, remoteFingerprint: string): Promise<boolean> {
    const entry = this.entries.get(key)
    if (!entry?.hasBytes) return Promise.resolve(false)
    // An entry that carries no token verifies against nothing, and says
    // so here rather than relying on the caller to ask only when it holds
    // one. Without the first clause a caller arriving with no remote
    // token compares null to null and is told the copy is fresh; the
    // redis store, whose meta key is simply absent, would answer false
    // for the same pair.
    return Promise.resolve(entry.fingerprint !== null && entry.fingerprint === remoteFingerprint)
  }

  isUnbounded(key: string): Promise<boolean> {
    const entry = this.entries.get(key)
    return Promise.resolve(entry !== undefined && entry.hasBytes && entry.ttl === null)
  }

  clear(): Promise<void> {
    this.invalidation.invalidateAll()
    this.entries.clear()
    this.store.files.clear()
    this.size = 0
    this.lock.clear()
    return Promise.resolve()
  }

  async multiGet(keys: readonly string[]): Promise<(Uint8Array | null)[]> {
    const out: (Uint8Array | null)[] = []
    for (const k of keys) out.push(await this.get(k))
    return out
  }

  private async evict(): Promise<void> {
    while (this.size > this.limit && this.entries.size > 0) {
      const firstKey = this.entries.keys().next().value
      if (firstKey === undefined) break
      await this.lock.withLock(firstKey, () => {
        const entry = this.entries.get(firstKey)
        if (entry === undefined) return Promise.resolve()
        this.dropEntry(firstKey)
        return Promise.resolve()
      })
      this.lock.discard(firstKey)
    }
  }
}
