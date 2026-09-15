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

import { RAMResource } from '../../resource/ram/ram.ts'
import type { PathSpec } from '../../types.ts'
import { Invalidation } from '../invalidation.ts'
import { KeyLock } from '../lock.ts'
import { CacheEntry } from './entry.ts'
import { type FileCache, validateMaxDrainBytes } from './mixin.ts'
import { defaultFingerprintAsync, parseLimit } from './utils.ts'

export class RAMFileCacheStore extends RAMResource implements FileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly lock = new KeyLock()
  private readonly limit: number
  private size = 0
  private readonly invalidation = new Invalidation()
  private maxDrainBytesValue: number | null = null
  // Promises cannot be cancelled; clearing the map makes the drain's
  // completion check fail so the result is discarded instead.
  readonly drainTasks = new Map<string, Promise<void>>()

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

  get(key: string): Promise<Uint8Array | null> {
    return this.lock.withLock(key, () => {
      const entry = this.entries.get(key)
      if (entry === undefined) return Promise.resolve(null)
      if (entry.expired) {
        this.size -= entry.size
        this.entries.delete(key)
        this.store.files.delete(key)
        return Promise.resolve(null)
      }
      this.entries.delete(key)
      this.entries.set(key, entry)
      return Promise.resolve(this.store.files.get(key) ?? null)
    })
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
        const fp = options.fingerprint ?? (await defaultFingerprintAsync(data))
        if (this.invalidation.stale(key, stamp)) return
        const existing = this.entries.get(key)
        if (existing !== undefined) {
          this.size -= existing.size
          this.entries.delete(key)
        }
        const entry = new CacheEntry({
          size: data.byteLength,
          cachedAt: Math.floor(Date.now() / 1000),
          fingerprint: fp,
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

  async add(
    key: string,
    data: Uint8Array,
    options: { fingerprint?: string | null; ttl?: number | null } = {},
  ): Promise<boolean> {
    const stamp = this.invalidation.enter(key)
    let placed: boolean
    try {
      placed = await this.lock.withLock(key, async () => {
        const existing = this.entries.get(key)
        if (existing !== undefined && !existing.expired) return Promise.resolve(false)
        const fp = options.fingerprint ?? (await defaultFingerprintAsync(data))
        if (this.invalidation.stale(key, stamp)) return false
        if (existing !== undefined) {
          this.size -= existing.size
          this.entries.delete(key)
        }
        const entry = new CacheEntry({
          size: data.byteLength,
          cachedAt: Math.floor(Date.now() / 1000),
          fingerprint: fp,
          ttl: options.ttl ?? null,
        })
        this.entries.set(key, entry)
        this.store.files.set(key, data)
        this.size += entry.size
        return Promise.resolve(true)
      })
    } finally {
      this.invalidation.leave(key)
    }
    if (placed) await this.evict()
    return placed
  }

  async evictPrefix(prefix: string): Promise<void> {
    // Store-wide: a fill in flight under the prefix has no entry yet, so
    // its key cannot be enumerated below.
    this.invalidation.invalidateAll()
    // A pending fill may not have installed an entry yet.
    const keys = [...new Set([...this.entries.keys(), ...this.drainTasks.keys()])].filter((k) =>
      k.startsWith(prefix),
    )
    for (const key of keys) await this.remove(key)
  }

  evictPaths(paths: Iterable<string>): void {
    for (const key of paths) {
      this.invalidation.invalidate(key)
      const entry = this.entries.get(key)
      if (entry !== undefined) {
        this.size -= entry.size
        this.entries.delete(key)
      }
      this.store.files.delete(key)
    }
  }

  remove(key: string): Promise<void> {
    this.drainTasks.delete(key)
    return this.lock.withLock(key, () => {
      // Advanced here, when the removal takes effect, not when it was
      // called: a writer queued behind it took its stamp before this ran,
      // and only a later invalidation tells it its bytes predate the
      // removal. Per key: a fill of another key still hashing is not this
      // removal's business.
      this.invalidation.invalidate(key)
      const entry = this.entries.get(key)
      if (entry !== undefined) {
        this.size -= entry.size
        this.entries.delete(key)
        this.store.files.delete(key)
      }
      this.lock.discard(key)
      return Promise.resolve()
    })
  }

  override exists(key: string | PathSpec): Promise<boolean> {
    const k = typeof key === 'string' ? key : key.mountPath
    const entry = this.entries.get(k)
    return Promise.resolve(entry !== undefined && !entry.expired)
  }

  isFresh(key: string, remoteFingerprint: string): Promise<boolean> {
    const entry = this.entries.get(key)
    if (entry === undefined) return Promise.resolve(false)
    return Promise.resolve(entry.fingerprint === remoteFingerprint)
  }

  clear(): Promise<void> {
    this.invalidation.invalidateAll()
    this.drainTasks.clear()
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
        this.entries.delete(firstKey)
        this.size -= entry.size
        this.store.files.delete(firstKey)
        return Promise.resolve()
      })
      this.lock.discard(firstKey)
    }
  }
}
