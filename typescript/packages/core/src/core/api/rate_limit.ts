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

import { SystemClock, type Clock } from '../../utils/clock.ts'

/**
 * Spaces calls that share a key to at most `rate` per second.
 *
 * For an API that meters requests per second per resource and answers a
 * burst with a penalty window rather than a queue (Airtable allows 5 per
 * base, then refuses everything for 30 seconds), spacing the calls up front
 * is cheaper than any retry. Each call reserves the next free slot for its
 * key before it awaits anything, so concurrent callers queue in arrival
 * order with no lock. A caller woken late (a blocked event loop, a throttled
 * browser timer) moves every slot behind it back by as much, so a stall
 * cannot release the callers queued behind it in one burst.
 */
export class RateLimiter {
  private readonly interval: number
  private clock: Clock
  private readonly next = new Map<string, number>()
  private readonly shift = new Map<string, number>()

  /**
   * @param clock what slots are read and waited on; omitted means the system
   *   clock until `bindClock` names the workspace's.
   */
  constructor(rate: number, clock?: Clock) {
    if (!(rate > 0)) throw new RangeError(`rate must be positive, got ${String(rate)}`)
    this.interval = 1 / rate
    this.clock = clock ?? new SystemClock()
  }

  /**
   * Read and wait on the workspace's clock from now on. Slots taken on another
   * clock mean nothing on this one, so they are dropped; binding the clock
   * already in use keeps them, so a second mount of one accessor cannot
   * release a burst.
   */
  bindClock(clock: Clock): void {
    if (clock === this.clock) return
    this.clock = clock
    this.next.clear()
    this.shift.clear()
  }

  /** Wait for this key's next slot (an Airtable base id). */
  async acquire(key: string): Promise<void> {
    let now = this.clock.monotonic()
    let slot = Math.max(now, this.next.get(key) ?? now)
    this.next.set(key, slot + this.interval)
    if (slot <= now) return
    let seen = this.shift.get(key) ?? 0
    await this.clock.sleep(slot - now)
    for (let moved = this.shift.get(key) ?? 0; moved !== seen; moved = this.shift.get(key) ?? 0) {
      slot += moved - seen
      seen = moved
      now = this.clock.monotonic()
      if (slot > now) await this.clock.sleep(slot - now)
    }
    const late = this.clock.monotonic() - slot
    if (late > 0) {
      this.shift.set(key, seen + late)
      this.next.set(key, (this.next.get(key) ?? slot) + late)
    }
  }
}
