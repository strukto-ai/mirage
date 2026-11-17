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
import { RecentChanges, SERVED_BY } from './changes.ts'
import { ManualClock } from '../utils/clock.ts'

const SERVED = new Map([['/data', 0]])

describe('RecentChanges', () => {
  it('waits out a change another made to the window', async () => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    changes.note('/data/f')
    clock.advance(0.25)
    await changes.waitOut(SERVED, 'box')
    expect(clock.monotonic()).toBe(1)
  })

  it("leaves a machine's own change to the others to wait out", async () => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    await SERVED_BY.run('box', () => {
      changes.note('/data/f')
    })
    await changes.waitOut(SERVED, 'box')
    expect(clock.monotonic()).toBe(0)
    await changes.waitOut(SERVED, 'gpu')
    expect(clock.monotonic()).toBe(1)
  })

  it.each([
    ['/data', true],
    ['/data/a/b', true],
    ['/', true],
    ['/database/x', false],
    ['/dev/null', false],
    ['/tmp/x', false],
  ])('waits out a change at %s only when it reaches a served prefix', async (path, waited) => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    changes.note(path)
    await changes.waitOut(SERVED, 'box')
    expect(clock.monotonic()).toBe(waited ? 1 : 0)
  })

  it('forgets a change older than the window', async () => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    changes.note('/data/f')
    clock.advance(1)
    await changes.waitOut(SERVED, 'box')
    expect(clock.monotonic()).toBe(1)
  })

  it('does not wait out a change made before its mount began', async () => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    changes.note('/data/f')
    clock.advance(0.25)
    await changes.waitOut(new Map([['/data', changes.now()]]), 'box')
    expect(clock.monotonic()).toBe(0.25)
  })

  it('ends the wait at once on a line already stopped', async () => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    changes.note('/data/f')
    await expect(changes.waitOut(SERVED, 'box', AbortSignal.abort())).rejects.toThrow()
    expect(clock.monotonic()).toBe(0)
  })

  it('keeps answering past a long run of expired changes', async () => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    for (let at = 0; at < 1000; at += 1) {
      changes.note('/data/f')
      clock.advance(0.01)
    }
    await changes.waitOut(SERVED, 'box')
    expect(clock.monotonic()).toBeCloseTo(10.99)
  })
})
