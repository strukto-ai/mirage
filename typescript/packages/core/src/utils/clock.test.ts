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
import { type Clock, ManualClock, SystemClock } from './clock.ts'

describe('SystemClock', () => {
  it('satisfies the Clock interface', () => {
    const clock: Clock = new SystemClock()
    expect(typeof clock.now()).toBe('number')
    expect(typeof clock.monotonic()).toBe('number')
  })

  it('now tracks the wall clock', () => {
    const before = Date.now() / 1000
    const reading = new SystemClock().now()
    const after = Date.now() / 1000
    expect(reading).toBeGreaterThanOrEqual(before)
    expect(reading).toBeLessThanOrEqual(after)
  })

  it('monotonic never decreases', () => {
    const clock = new SystemClock()
    const readings = Array.from({ length: 50 }, () => clock.monotonic())
    expect(readings).toEqual([...readings].sort((a, b) => a - b))
  })
})

describe('ManualClock', () => {
  it('satisfies the Clock interface', () => {
    const clock: Clock = new ManualClock()
    expect(clock.now()).toBe(0)
    expect(clock.monotonic()).toBe(0)
  })

  it('stands still when read', () => {
    // Reading must have no side effect: a deadline that moved every time
    // the code under test glanced at the clock would make every boundary
    // assertion depend on the number of glances.
    const clock = new ManualClock(100)
    expect(clock.now()).toBe(100)
    expect(clock.now()).toBe(100)
    expect(clock.monotonic()).toBe(0)
    expect(clock.monotonic()).toBe(0)
  })

  it('advance moves both readings', () => {
    const clock = new ManualClock(1000)
    clock.advance(30)
    expect(clock.now()).toBe(1030)
    expect(clock.monotonic()).toBe(30)
  })

  it('advance accumulates', () => {
    const clock = new ManualClock()
    clock.advance(0.5)
    clock.advance(0.25)
    expect(clock.monotonic()).toBe(0.75)
  })

  it('orders two events by advancing between them', () => {
    // The ordering case the ticking draft existed for, done explicitly.
    const clock = new ManualClock(1000)
    const first = clock.now()
    clock.advance(1)
    expect(clock.now()).toBeGreaterThan(first)
  })

  it('refuses to go backwards', () => {
    expect(() => {
      new ManualClock().advance(-1)
    }).toThrow(RangeError)
  })
})
