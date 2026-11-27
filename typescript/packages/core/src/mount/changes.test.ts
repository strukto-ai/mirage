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

  // Twin of test_a_change_since_the_count_reaches_the_file_it_overlaps.
  it.each([
    ['/data/f', true],
    ['/data', true],
    ['/', true],
    ['/data/f/x', true],
    ['/data/g', false],
    ['/data/f2', false],
  ])('counts a change at %s since the count as reaching /data/f: %s', (path, reached) => {
    const changes = new RecentChanges(new ManualClock(), 1)
    changes.note('/elsewhere')
    const count = changes.count
    changes.note(path)
    expect(changes.reachedSince(count, ['/data/f'])).toBe(reached)
  })

  // Twin of test_a_change_before_the_count_reaches_nothing_read_after_it.
  it('counts no change before the count as reaching what was read after it', () => {
    const changes = new RecentChanges(new ManualClock(), 1)
    changes.note('/data/f')
    const count = changes.count
    expect(changes.reachedSince(count, ['/data/f'])).toBe(false)
    changes.note('/data/g')
    expect(changes.reachedSince(count, ['/data/f'])).toBe(false)
  })

  // Twin of test_either_spelling_of_a_read_file_is_reached: a file read
  // through a link is reached by a change to the name typed and to the one the
  // link leads to.
  it('reaches either spelling of a file read', () => {
    const changes = new RecentChanges(new ManualClock(), 1)
    const count = changes.count
    changes.note('/data/real')
    expect(changes.reachedSince(count, ['/data/link', '/data/real'])).toBe(true)
  })

  // Twin of test_a_forgotten_change_counts_as_reaching_every_file: past the
  // window nothing is left to tell where a change landed.
  it('counts a forgotten change as reaching every file', () => {
    const clock = new ManualClock()
    const changes = new RecentChanges(clock, 1)
    const count = changes.count
    changes.note('/data/g')
    clock.advance(1)
    changes.note('/data/h')
    expect(changes.reachedSince(count, ['/data/f'])).toBe(true)
    expect(changes.reachedSince(changes.count, ['/data/f'])).toBe(false)
  })
})
