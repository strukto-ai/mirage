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

export interface CacheEntryInit {
  size: number
  cachedAt: number
  fingerprint?: string | null
  ttl?: number | null
}

export class CacheEntry {
  readonly size: number
  readonly cachedAt: number
  readonly fingerprint: string | null
  readonly ttl: number | null

  constructor(init: CacheEntryInit) {
    this.size = init.size
    this.cachedAt = init.cachedAt
    this.fingerprint = init.fingerprint ?? null
    this.ttl = init.ttl ?? null
    Object.freeze(this)
  }

  /**
   * Check expiry using the RAMFileCacheStore's clock reading.
   *
   * @param now whole seconds since the unix epoch.
   */
  isExpired(now: number): boolean {
    if (this.ttl === null) return false
    return now - this.cachedAt >= this.ttl
  }
}
