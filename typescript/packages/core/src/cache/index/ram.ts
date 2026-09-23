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
import { underPath } from '../../utils/key_prefix.ts'
import { KeyLock } from '../lock.ts'
import { LookupStatus, type IndexEntry, type ListResult, type LookupResult } from './config.ts'
import { IndexCacheStore } from './store.ts'

export class RAMIndexCacheStore extends IndexCacheStore {
  private readonly ttl: number
  private readonly entryMap = new Map<string, IndexEntry>()
  private readonly children = new Map<string, string[]>()
  private readonly expiry = new Map<string, number>()
  private readonly lock = new KeyLock()

  constructor(options: { ttl?: number } = {}) {
    super()
    this.ttl = options.ttl ?? 600
  }

  seed(
    entries: ReadonlyMap<string, IndexEntry>,
    children: ReadonlyMap<string, readonly string[]>,
    expiresAt: Date,
  ): void {
    const nowIso = toIsoZ(new Date())
    for (const [path, entry] of entries) {
      this.entryMap.set(
        path,
        entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry,
      )
    }
    for (const [path, keys] of children) {
      this.children.set(path, [...keys])
      this.expiry.set(path, expiresAt.getTime())
    }
  }

  entries(): Promise<Map<string, IndexEntry>> {
    return Promise.resolve(new Map(this.entryMap))
  }

  get(vfsPath: string): Promise<LookupResult> {
    const entry = this.entryMap.get(vfsPath)
    if (entry === undefined) return Promise.resolve({ status: LookupStatus.NOT_FOUND })
    return Promise.resolve({ entry })
  }

  put(vfsPath: string, entry: IndexEntry): Promise<void> {
    return this.lock.withLock(vfsPath, () => {
      const stored =
        entry.indexTime === '' ? entry.copyWith({ indexTime: toIsoZ(new Date()) }) : entry
      this.entryMap.set(vfsPath, stored)
      return Promise.resolve()
    })
  }

  listDir(vfsPath: string): Promise<ListResult> {
    const exp = this.expiry.get(vfsPath)
    if (exp === undefined) return Promise.resolve({ status: LookupStatus.NOT_FOUND })
    if (Date.now() >= exp) return Promise.resolve({ status: LookupStatus.EXPIRED })
    const children = this.children.get(vfsPath) ?? []
    return Promise.resolve({ entries: children })
  }

  setDir(
    vfsPath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    return this.lock.withLock(vfsPath, () => {
      const now = Date.now()
      const exp = expiredAt ? expiredAt.getTime() : now + this.ttl * 1000
      const nowIso = toIsoZ(new Date(now))
      const prefix = vfsPath === '/' ? '/' : `${vfsPath}/`
      const childKeys: string[] = []
      for (const [name, entry] of entries) {
        const fullPath = prefix + name
        const stored = entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry
        this.entryMap.set(fullPath, stored)
        childKeys.push(fullPath)
      }
      this.children.set(vfsPath, childKeys)
      this.expiry.set(vfsPath, exp)
      return Promise.resolve()
    })
  }

  invalidateDir(vfsPath: string): Promise<void> {
    for (const child of this.children.get(vfsPath) ?? []) {
      this.entryMap.delete(child)
    }
    this.expiry.delete(vfsPath)
    this.children.delete(vfsPath)
    return Promise.resolve()
  }

  invalidatePrefix(vfsPath: string): Promise<void> {
    for (const key of [...this.entryMap.keys()]) {
      if (underPath(key, vfsPath)) this.entryMap.delete(key)
    }
    for (const key of [...this.children.keys()]) {
      if (underPath(key, vfsPath)) this.children.delete(key)
    }
    for (const key of [...this.expiry.keys()]) {
      if (underPath(key, vfsPath)) this.expiry.delete(key)
    }
    return Promise.resolve()
  }

  invalidate(): Promise<void> {
    const past = Date.now() - 1000
    for (const key of this.expiry.keys()) this.expiry.set(key, past)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.entryMap.clear()
    this.children.clear()
    this.expiry.clear()
    this.lock.clear()
    return Promise.resolve()
  }
}
