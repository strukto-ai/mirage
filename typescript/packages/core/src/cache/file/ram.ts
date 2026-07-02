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
import { KeyLock } from '../lock.ts'
import { CacheEntry } from './entry.ts'
import type { FileCache } from './mixin.ts'
import { defaultFingerprint, parseLimit } from './utils.ts'

export class RAMFileCacheStore extends RAMResource implements FileCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly lock = new KeyLock()
  private readonly limit: number
  private size = 0
  maxDrainBytes: number | null
  // Promises cannot be cancelled; clearing the map makes the drain's
  // completion check fail so the result is discarded instead.
  readonly drainTasks = new Map<string, Promise<void>>()

  constructor(options: { limit?: string | number; maxDrainBytes?: number | null } = {}) {
    super()
    this.limit = parseLimit(options.limit ?? '512MB')
    this.maxDrainBytes = options.maxDrainBytes ?? null
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
    await this.lock.withLock(key, () => {
      const existing = this.entries.get(key)
      if (existing !== undefined) {
        this.size -= existing.size
        this.entries.delete(key)
      }
      const fp = options.fingerprint ?? defaultFingerprint(data)
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
    await this.evict()
  }

  async add(
    key: string,
    data: Uint8Array,
    options: { fingerprint?: string | null; ttl?: number | null } = {},
  ): Promise<boolean> {
    const placed = await this.lock.withLock(key, () => {
      const existing = this.entries.get(key)
      if (existing !== undefined && !existing.expired) return Promise.resolve(false)
      if (existing !== undefined) {
        this.size -= existing.size
        this.entries.delete(key)
      }
      const fp = options.fingerprint ?? defaultFingerprint(data)
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
    if (placed) await this.evict()
    return placed
  }

  remove(key: string): Promise<void> {
    this.drainTasks.delete(key)
    return this.lock.withLock(key, () => {
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

  exists(key: string | PathSpec): Promise<boolean> {
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
    this.drainTasks.clear()
    this.entries.clear()
    this.store.files.clear()
    this.size = 0
    this.lock.clear()
    return Promise.resolve()
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
