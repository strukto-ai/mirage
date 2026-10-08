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

/** What a cache entry holds. Mirrors Python's `Holds`. */
export enum Holds {
  BYTES = 'bytes',
  BYTES_AND_VERSION = 'bytes_and_version',
  VERSION = 'version',
}

export interface CacheEntryInit {
  size: number
  cachedAt: number
  fingerprint?: string | null
  ttl?: number | null
  holds?: Holds
}

export class CacheEntry {
  readonly size: number
  readonly cachedAt: number
  readonly fingerprint: string | null
  readonly ttl: number | null
  readonly holds: Holds

  constructor(init: CacheEntryInit) {
    this.size = init.size
    this.cachedAt = init.cachedAt
    this.fingerprint = init.fingerprint ?? null
    this.ttl = init.ttl ?? null
    this.holds = init.holds ?? Holds.BYTES
    Object.freeze(this)
  }

  /** Whether the entry holds the file's bytes, not only its version. */
  get hasBytes(): boolean {
    return this.holds !== Holds.VERSION
  }

  get expired(): boolean {
    if (this.ttl === null) return false
    return Math.floor(Date.now() / 1000) - this.cachedAt >= this.ttl
  }
}
