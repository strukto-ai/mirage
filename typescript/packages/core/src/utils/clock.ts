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

import { sleep } from './abort.ts'
import { createAsyncContext } from './async_context.ts'

/** Wall time for timestamps and monotonic time for durations, in seconds. */
export interface Clock {
  /** Seconds since the unix epoch. */
  now(): number
  /** Seconds from an arbitrary origin that never moves backwards. */
  monotonic(): number
  /** Wait `seconds` on this clock; zero or less returns at once. */
  sleep(seconds: number): Promise<void>
}

/** Platform clock used when no clock is supplied. */
export class SystemClock implements Clock {
  /** Marks a platform clock, so two copies of this module still agree. */
  readonly platform = true

  /** Seconds since the unix epoch. */
  now(): number {
    return Date.now() / 1000
  }

  /** Seconds from an arbitrary origin that never moves backwards. */
  monotonic(): number {
    return performance.now() / 1000
  }

  /** Wait `seconds` of real time; zero or less returns at once. */
  sleep(seconds: number): Promise<void> {
    return sleep(seconds * 1000)
  }
}

/**
 * Clock advanced explicitly by the caller. Readings have no side effects.
 * A sleep advances the clock by its length and returns without waiting, so
 * a wait costs no real time. Waits do not overlap: two tasks that each sleep
 * 30 seconds advance it by 60.
 */
export class ManualClock implements Clock {
  private wall: number
  private mono = 0

  /** @param start initial wall time in seconds; monotonic starts at zero. */
  constructor(start = 0) {
    this.wall = start
  }

  /** Seconds on the virtual wall clock. */
  now(): number {
    return this.wall
  }

  /** Seconds on the virtual monotonic clock. */
  monotonic(): number {
    return this.mono
  }

  /**
   * Move the clock forward by `seconds`.
   *
   * @param seconds how far forward to move; must not be negative, since
   *   a monotonic reading may not go back.
   */
  advance(seconds: number): void {
    if (seconds < 0) throw new RangeError('cannot advance a clock backwards')
    this.wall += seconds
    this.mono += seconds
  }

  /**
   * Advance by `seconds` and yield once. Zero, a negative or NaN advances
   * nothing.
   */
  async sleep(seconds: number): Promise<void> {
    if (seconds > 0) this.advance(seconds)
    await Promise.resolve()
  }
}

/** Whether `clock` reads the platform clock, so any two such agree. */
export function isSystemClock(clock: Clock): boolean {
  return (clock as { platform?: unknown }).platform === true
}

/**
 * `base` shifted by a fixed offset: it starts at the instant it is built for
 * and ticks at `base`'s rate, as a workspace's `system_time` does. Monotonic
 * time and waits are `base`'s. Mirrors Python's `ShiftedClock`.
 */
export class ShiftedClock implements Clock {
  /**
   * @param base the clock it ticks with.
   * @param offset seconds added to `base`'s wall time.
   */
  constructor(
    readonly base: Clock,
    readonly offset: number,
  ) {}

  /** `base` shifted so that it reads `start` seconds now. */
  static starting(base: Clock, start: number): ShiftedClock {
    return new ShiftedClock(base, start - base.now())
  }

  /** Seconds since the unix epoch, shifted. */
  now(): number {
    return this.base.now() + this.offset
  }

  /** `base`'s monotonic seconds. */
  monotonic(): number {
    return this.base.monotonic()
  }

  /** Wait `seconds` on `base`. */
  sleep(seconds: number): Promise<void> {
    return this.base.sleep(seconds)
  }
}

// An ISO 8601 instant with an offset: `2026-03-02T09:00:00Z`, `+08:00`.
const INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):([0-5]\d))$/
// 2262-01-01T00:00:00Z, the first second a guest's nanosecond clock cannot
// hold.
const SYSTEM_TIME_END = 9214646400

/**
 * Seconds since the unix epoch a `system_time` names: an ISO 8601 instant
 * with an offset (`Z` or `+08:00`), from 1970 through 2261, the years a
 * guest's nanosecond clock holds. Mirrors Python's `parse_system_time`.
 *
 * @throws Error when it is not one.
 */
export function parseSystemTime(text: string): number {
  // Each field in its range, as Python's `datetime.fromisoformat` holds it
  // (Date.parse lets `02-30` and `24:00` roll over), and milliseconds
  // kept, as Date's are.
  const m = INSTANT.exec(text)
  let seconds = NaN
  if (m !== null) {
    // An unmatched group (no seconds) is undefined.
    const fields = m.slice(1, 7) as (string | undefined)[]
    const [year, month, day, hour, minute, second] = fields.map((f) => Number(f ?? 0))
    const ms = Number(((m[7] ?? '') + '000').slice(0, 3))
    const offset = m[8] === 'Z' ? 0 : (m[9] === '-' ? -1 : 1) * (Number(m[10]) * 60 + Number(m[11]))
    const at = Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute, second, ms)
    const back = new Date(at)
    if (
      back.getUTCFullYear() === year &&
      back.getUTCMonth() + 1 === month &&
      back.getUTCDate() === day &&
      back.getUTCHours() === hour &&
      back.getUTCMinutes() === minute &&
      back.getUTCSeconds() === second &&
      Math.abs(offset) < 24 * 60
    ) {
      seconds = (at - offset * 60_000) / 1000
    }
  }
  if (!(seconds >= 0 && seconds < SYSTEM_TIME_END)) {
    throw new Error(
      `system_time ${JSON.stringify(text)} is not an ISO 8601 instant with an offset from 1970 through 2261, as 2026-03-02T09:00:00Z`,
    )
  }
  return seconds
}

// The system clock of the workspace a line or an op runs in: what `date`,
// file times and the runtimes read. Null, or unbound, is the host's time.
const systemClock = createAsyncContext<Clock | null>()

/**
 * `fn` run on a workspace's system clock, which `systemNow` reads. Mirrors
 * Python's `run_with_system_clock`.
 */
export function runWithSystemClock<T>(clock: Clock | null, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(systemClock.run(clock, fn))
}

/**
 * The running workspace's system clock, null for the host's. A browser
 * cannot tell one task's binding from another's, so there it is the newest
 * live one. Mirrors Python's `bound_system_clock`.
 */
export function boundSystemClock(): Clock | null {
  return systemClock.getStore() ?? null
}

/**
 * Seconds since the unix epoch on the running workspace's system clock: what
 * the agent sees as now. Mirrors Python's `system_now`.
 */
export function systemNow(): number {
  const clock = boundSystemClock()
  return clock === null ? Date.now() / 1000 : clock.now()
}

/** `systemNow` as a `Date`. */
export function systemDate(): Date {
  return new Date(systemNow() * 1000)
}
