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

export type Stamp = readonly [epoch: number, key: number]

/**
 * The invalidations a cache writer checks before it installs.
 *
 * A writer holds bytes it read earlier; an invalidation that lands between
 * the read and the install makes them stale even though the writer was
 * granted its turn after it. The writer takes a stamp before it waits and
 * compares it before it installs.
 *
 * The window is open only where the writer actually suspends in between,
 * and that differs by host. Here it always does: `KeyLock.withLock` awaits
 * an already-resolved promise, which is a microtask yield, and the redis
 * store additionally awaits its client. On python it currently never does
 * (`asyncio.Lock.acquire` returns without suspending when the lock is
 * free), so the check is dormant there rather than dead -- it is the
 * contract both hosts share, and the guard that keeps a future await from
 * silently reopening the window.
 *
 * Two counters, because invalidations have two reaches. The store-wide
 * epoch answers `clear` and a prefix eviction, whose victims cannot be
 * enumerated (a fill in flight has no entry yet). The per-key counter
 * answers a removal of one key, so a large fill for one key is not
 * thrown away because an unrelated key was removed. Per-key counters
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

  /** Record an invalidation whose victims cannot be enumerated. */
  invalidateAll(): void {
    this.epoch++
  }
}
