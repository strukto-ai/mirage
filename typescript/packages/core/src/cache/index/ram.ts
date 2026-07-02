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

import { KeyLock } from '../lock.ts'
import { LookupStatus, type IndexEntry, type ListResult, type LookupResult } from './config.ts'
import { IndexCacheStore } from './store.ts'

export class RAMIndexCacheStore extends IndexCacheStore {
  private readonly ttl: number
  private readonly entries = new Map<string, IndexEntry>()
  private readonly children = new Map<string, string[]>()
  private readonly expiry = new Map<string, number>()
  private readonly lock = new KeyLock()

  constructor(options: { ttl?: number } = {}) {
    super()
    this.ttl = options.ttl ?? 600
  }

  get(resourcePath: string): Promise<LookupResult> {
    const entry = this.entries.get(resourcePath)
    if (entry === undefined) return Promise.resolve({ status: LookupStatus.NOT_FOUND })
    return Promise.resolve({ entry })
  }

  put(resourcePath: string, entry: IndexEntry): Promise<void> {
    return this.lock.withLock(resourcePath, () => {
      const stored =
        entry.indexTime === '' ? entry.copyWith({ indexTime: new Date().toISOString() }) : entry
      this.entries.set(resourcePath, stored)
      return Promise.resolve()
    })
  }

  listDir(resourcePath: string): Promise<ListResult> {
    const exp = this.expiry.get(resourcePath)
    if (exp === undefined) return Promise.resolve({ status: LookupStatus.NOT_FOUND })
    if (Date.now() > exp) return Promise.resolve({ status: LookupStatus.EXPIRED })
    const children = this.children.get(resourcePath) ?? []
    return Promise.resolve({ entries: children })
  }

  setDir(
    resourcePath: string,
    entries: readonly [string, IndexEntry][],
    expiredAt?: Date | null,
  ): Promise<void> {
    return this.lock.withLock(resourcePath, () => {
      const now = Date.now()
      const exp = expiredAt ? expiredAt.getTime() : now + this.ttl * 1000
      const nowIso = new Date(now).toISOString()
      const prefix = resourcePath === '/' ? '/' : `${resourcePath}/`
      const childKeys: string[] = []
      for (const [name, entry] of entries) {
        const fullPath = prefix + name
        const stored = entry.indexTime === '' ? entry.copyWith({ indexTime: nowIso }) : entry
        this.entries.set(fullPath, stored)
        childKeys.push(fullPath)
      }
      this.children.set(resourcePath, childKeys)
      this.expiry.set(resourcePath, exp)
      return Promise.resolve()
    })
  }

  invalidateDir(resourcePath: string): Promise<void> {
    for (const child of this.children.get(resourcePath) ?? []) {
      this.entries.delete(child)
    }
    this.expiry.delete(resourcePath)
    this.children.delete(resourcePath)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.entries.clear()
    this.children.clear()
    this.expiry.clear()
    this.lock.clear()
    return Promise.resolve()
  }
}
