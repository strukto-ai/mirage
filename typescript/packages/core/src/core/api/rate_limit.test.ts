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

import { describe, expect, it } from 'vitest'
import { ManualClock, SystemClock } from '../../utils/clock.ts'
import { RateLimiter } from './rate_limit.ts'

class Clock {
  wall = 100
  readonly waits: number[] = []
  now = (): number => this.wall
  monotonic = (): number => this.wall
  sleep = (seconds: number): Promise<void> => {
    this.waits.push(seconds)
    return Promise.resolve()
  }
}

class YieldingClock extends Clock {
  override sleep = async (seconds: number): Promise<void> => {
    this.waits.push(seconds)
    await Promise.resolve()
  }
}

class StalledClock extends Clock {
  constructor(readonly until: number) {
    super()
  }

  override sleep = async (seconds: number): Promise<void> => {
    const start = this.wall
    this.waits.push(seconds)
    await Promise.resolve()
    this.wall = Math.max(this.wall, start + seconds, this.until)
  }
}

function limiter(rate: number, clock: Clock): RateLimiter {
  return new RateLimiter(rate, clock)
}

describe('RateLimiter', () => {
  it('spaces calls sharing a key by the rate', async () => {
    const clock = new Clock()
    const limit = limiter(5, clock)
    for (let i = 0; i < 4; i++) await limit.acquire('appA')
    // the first call goes at once; each later one waits for its own slot
    expect(clock.waits.map((w) => Number(w.toFixed(6)))).toEqual([0.2, 0.4, 0.6])
  })

  it('paces keys independently', async () => {
    const clock = new Clock()
    const limit = limiter(5, clock)
    await limit.acquire('appA')
    await limit.acquire('appB')
    expect(clock.waits).toEqual([])
  })

  it('costs no wait once the slot is past', async () => {
    const clock = new Clock()
    const limit = limiter(5, clock)
    await limit.acquire('appA')
    clock.wall += 1
    await limit.acquire('appA')
    expect(clock.waits).toEqual([])
  })

  it('reserves slots for concurrent callers in arrival order', async () => {
    const clock = new Clock()
    const limit = limiter(10, clock)
    await Promise.all([limit.acquire('appA'), limit.acquire('appA'), limit.acquire('appA')])
    expect(clock.waits.map((w) => Number(w.toFixed(6))).sort()).toEqual([0.1, 0.2])
  })

  it('moves the slots behind a late wake', async () => {
    const clock = new StalledClock(100.5)
    const limit = limiter(5, clock)
    const starts: number[] = []
    const call = async (): Promise<void> => {
      await limit.acquire('appA')
      starts.push(clock.wall)
    }
    await Promise.all([call(), call(), call()])
    await call()
    // the loop was blocked until 100.5, so the second and third callers
    // wake together; the third still goes a full interval after the second
    expect(starts.map((s) => Number(s.toFixed(6)))).toEqual([100, 100.5, 100.7, 100.9])
  })

  it('refuses a rate that is not positive', () => {
    expect(() => new RateLimiter(0)).toThrow(RangeError)
  })

  it('paces and waits on a bound clock', async () => {
    const limiter = new RateLimiter(5)
    const clock = new ManualClock()
    limiter.bindClock(clock, 'ws')
    await limiter.acquire('appA')
    await limiter.acquire('appA')
    expect(clock.monotonic()).toBeCloseTo(0.2)
  })

  it('keeps the schedule when the clock in use is bound again', async () => {
    const clock = new Clock()
    const l = limiter(5, clock)
    await l.acquire('appA')
    l.bindClock(clock, 'ws')
    await l.acquire('appA')
    expect(clock.waits).toEqual([expect.closeTo(0.2)])
  })

  it('lets a waiting caller finish when a new clock is bound', async () => {
    const clock = new StalledClock(0)
    const l = limiter(5, clock)
    await l.acquire('appA')
    const waiting = l.acquire('appA')
    await Promise.resolve()
    const later = new Clock()
    later.wall = 200
    l.bindClock(later, 'ws')
    await waiting
    expect(clock.waits).toEqual([expect.closeTo(0.2)])
  })

  it('keeps a caller from the old clock off the new schedule', async () => {
    const clock = new StalledClock(0)
    const l = limiter(5, clock)
    await l.acquire('appA')
    const waiting = l.acquire('appA')
    await Promise.resolve()
    const later = new Clock()
    later.wall = 200
    l.bindClock(later, 'ws')
    await l.acquire('appA')
    await waiting
    await l.acquire('appA')
    expect(later.waits).toEqual([expect.closeTo(0.2)])
  })

  it('keeps a caller from before a round trip of clocks off the schedule', async () => {
    const clock = new YieldingClock()
    const l = limiter(5, clock)
    await l.acquire('appA')
    const stale = l.acquire('appA')
    await Promise.resolve()
    l.bindClock(new Clock(), 'ws')
    l.bindClock(clock, 'ws')
    clock.wall = 101
    await l.acquire('appA')
    const fresh = l.acquire('appA')
    await Promise.all([stale, fresh])
    expect(clock.waits).toEqual([expect.closeTo(0.2), expect.closeTo(0.2)])
  })

  it('refuses another clock while held, until its owner lets go', () => {
    const l = new RateLimiter(5)
    const second = new ManualClock()
    l.bindClock(new ManualClock(), 'a')
    expect(() => {
      l.bindClock(second, 'b')
    }).toThrow(/another clock/)
    l.releaseClock('a')
    l.bindClock(second, 'b')
  })

  it('lets two system clocks agree while held', () => {
    const l = new RateLimiter(5)
    l.bindClock(new SystemClock(), 'a')
    l.bindClock(new SystemClock(), 'b')
    expect(() => {
      l.bindClock(new ManualClock(), 'c')
    }).toThrow()
  })
})
