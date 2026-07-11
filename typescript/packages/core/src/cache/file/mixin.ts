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

import type { PathSpec } from '../../types.ts'

export interface FileCache {
  get(key: string): Promise<Uint8Array | null>
  set(
    key: string,
    data: Uint8Array,
    options?: { fingerprint?: string | null; ttl?: number | null },
  ): Promise<void>
  add(
    key: string,
    data: Uint8Array,
    options?: { fingerprint?: string | null; ttl?: number | null },
  ): Promise<boolean>
  remove(key: string): Promise<void>
  exists(key: string | PathSpec): Promise<boolean>
  isFresh(key: string, remoteFingerprint: string): Promise<boolean>
  clear(): Promise<void>
  allCached(keys: readonly string[]): Promise<boolean>
  multiGet(keys: readonly string[]): Promise<(Uint8Array | null)[]>
  // Cached bytes / entry count; null (or absent) for stores that don't
  // track them client-side (e.g. redis owns its own keyspace).
  readonly cacheSize: number | null
  readonly cacheEntries?: number | null
  readonly cacheLimit: number
  maxDrainBytes: number | null
  // Present only on stores that support background drains (mirrors the
  // Python RAM cache's _drain_tasks); applyIo skips draining without it.
  readonly drainTasks?: Map<string, Promise<void>>
}

/**
 * Max bytes a background drain may buffer to fill the cache.
 *
 * null (the default) derives the budget from `cacheLimit`: on evicting
 * stores (RAM) a larger entry is dropped straight after the add, and on
 * advisory stores (Redis) the limit still expresses the operator's
 * cache-size intent while bounding the client-side drain buffer. An
 * explicit `maxDrainBytes` is honored as configured, even above
 * `cacheLimit`. Mirrors the Python `FileCacheMixin.drain_budget`.
 */
export function drainBudget(cache: FileCache): number {
  return cache.maxDrainBytes ?? cache.cacheLimit
}
