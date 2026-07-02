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

import { Accessor } from './base.ts'
import type { MongoDriver } from '../core/mongodb/_driver.ts'
import type { MongoDBConfigResolved } from '../resource/mongodb/config.ts'

interface CacheEntry<T> {
  value: T
  expires: number
}

export class MongoDBAccessor extends Accessor {
  readonly driver: MongoDriver
  readonly config: MongoDBConfigResolved
  readonly listingCacheTtlMs: number
  private readonly cache = new Map<string, CacheEntry<unknown>>()

  constructor(
    driver: MongoDriver,
    config: MongoDBConfigResolved,
    options: { listingCacheTtlMs?: number } = {},
  ) {
    super()
    this.driver = driver
    this.config = config
    this.listingCacheTtlMs = options.listingCacheTtlMs ?? 5000
  }

  async cachedList<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    if (this.listingCacheTtlMs <= 0) return fetch()
    const now = Date.now()
    const hit = this.cache.get(key)
    if (hit !== undefined && hit.expires > now) return hit.value as T
    const value = await fetch()
    this.cache.set(key, { value, expires: now + this.listingCacheTtlMs })
    return value
  }
}
