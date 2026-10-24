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

export type Stamp = readonly [epoch: number, key: number]

/**
 * The invalidations a cache writer checks before it installs.
 *
 * A writer holds bytes it read earlier; an invalidation that lands between
 * the read and the install makes them stale even though the writer was
 * granted its turn after it. The writer takes a stamp before it waits and
 * compares it before it installs.
 *
 * The RAM store holds a per-key lock only for its in-memory install,
 * never across hashing or backend I/O. A free lock admits its writer
 * without suspending on both hosts; a queued writer checks its stamp
 * after acquiring the lock. Redis holds no client-side key lock: it
 * sends atomic writes to the server and checks after acquiring its
 * client (an await on TypeScript, synchronous on Python). The guard
 * tracks local invalidations, not writes by other Redis clients.
 *
 * Two counters, because invalidations have different reaches. The
 * store-wide epoch answers `clear`. The per-key counter answers a removal
 * of one key and a prefix eviction, so a large fill is not thrown away
 * because an unrelated key or folder was dropped. A prefix eviction can
 * name its victims although a fill in flight has no entry yet: every
 * writer registers here in `enter` before it waits. Per-key counters
 * exist only while a writer for that key is in flight, which bounds the
 * map by concurrent writers, not by every key ever removed.
 */
export class Invalidation {
  private epoch = 0
  private readonly keys = new Map<string, number>()
  private readonly writers = new Map<string, number>()

  /** Register a writer for `key` and take its stamp. */
  enter(key: string): Stamp {
    this.writers.set(key, (this.writers.get(key) ?? 0) + 1)
    return [this.epoch, this.keys.get(key) ?? 0]
  }

  /** Unregister a writer for `key`; the last one out drops the key's counter. */
  leave(key: string): void {
    const left = (this.writers.get(key) ?? 1) - 1
    if (left > 0) {
      this.writers.set(key, left)
    } else {
      this.writers.delete(key)
      this.keys.delete(key)
    }
  }

  /** Whether an invalidation reached `key` since `stamp`. */
  stale(key: string, stamp: Stamp): boolean {
    return stamp[0] !== this.epoch || stamp[1] !== (this.keys.get(key) ?? 0)
  }

  /** Record a removal of `key` for the writers in flight on it. */
  invalidate(key: string): void {
    if (this.writers.has(key)) this.keys.set(key, (this.keys.get(key) ?? 0) + 1)
  }

  /**
   * Record a prefix eviction for the writers in flight under it, matched
   * as the stores match it (`startsWith`), sparing the excluded roots.
   */
  invalidatePrefix(prefix: string, excluded: readonly string[] = []): void {
    for (const key of this.writers.keys()) {
      if (key.startsWith(prefix) && !excluded.some((root) => underPath(key, root)))
        this.keys.set(key, (this.keys.get(key) ?? 0) + 1)
    }
  }

  /** Record an invalidation whose victims cannot be enumerated. */
  invalidateAll(): void {
    this.epoch++
  }
}

/**
 * Track a fill's keys until it completes, fails or is cancelled.
 *
 * The callback starts without a yield, before any lock/client wait. Call
 * its predicate immediately before each install or retry. Unknown keys
 * are not live, and duplicate keys count as one writer.
 */
export async function withFillGuard(
  invalidation: Invalidation,
  keys: Iterable<string>,
  fill: (isLive: (key: string) => boolean) => Promise<void>,
): Promise<void> {
  const stamps = new Map([...new Set(keys)].map((key) => [key, invalidation.enter(key)]))
  const isLive = (key: string): boolean => {
    const stamp = stamps.get(key)
    return stamp !== undefined && !invalidation.stale(key, stamp)
  }
  try {
    await fill(isLive)
  } finally {
    for (const key of stamps.keys()) invalidation.leave(key)
  }
}
