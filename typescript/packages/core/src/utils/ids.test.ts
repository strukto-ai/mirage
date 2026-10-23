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
import { ManualClock } from './clock.ts'
import {
  type IdSource,
  SeededIdSource,
  SystemIdSource,
  newSessionId,
  newWorkspaceId,
  randomBelow,
  randomBelowBig,
  shuffle,
  uuid7,
} from './ids.ts'

// Pinned by the python twin too (tests/utils/test_ids.py): one seed draws one
// sequence on both hosts.
const SEED_42_WORDS = [825760943, 2622800619, 310231447, 2495256757]
const SEED_7_IDS = [
  '018bcfe5-6800-70e6-beb7-02bf41b04f69',
  '018bcfe5-6800-70e7-86ef-ef930baa6e99',
  '018bcfe5-6801-70f9-94f4-c83f9b431a91',
]

function stampOf(value: string): number {
  return parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
}

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid7', () => {
  it('is canonical lowercase and version 7', () => {
    expect(uuid7()).toMatch(UUID7_RE)
  })

  it('embeds the current timestamp', () => {
    const before = Date.now()
    const value = uuid7()
    const after = Date.now()
    const embedded = parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
    expect(embedded).toBeGreaterThanOrEqual(before - 10)
    expect(embedded).toBeLessThanOrEqual(after + 10)
  })

  it('orders across milliseconds', async () => {
    const first = uuid7()
    await new Promise((r) => setTimeout(r, 2))
    const second = uuid7()
    expect(first < second).toBe(true)
  })

  it('is unique', () => {
    const values = new Set(Array.from({ length: 1000 }, () => uuid7()))
    expect(values.size).toBe(1000)
  })
})

describe('id kinds', () => {
  it('share the format', () => {
    expect(newWorkspaceId()).toMatch(UUID7_RE)
    expect(newSessionId()).toMatch(UUID7_RE)
  })
})

describe('SystemIdSource', () => {
  it('satisfies the protocol', () => {
    const ids: IdSource = new SystemIdSource()
    expect(ids.uuid7()).toMatch(UUID7_RE)
    const word = ids.randomU32()
    expect(Number.isInteger(word) && word >= 0 && word < 2 ** 32).toBe(true)
  })
})

describe('SeededIdSource', () => {
  it('replays its words', () => {
    const source = new SeededIdSource(42)
    expect(Array.from({ length: 4 }, () => source.randomU32())).toEqual(SEED_42_WORDS)
  })

  it('draws another sequence for another seed', () => {
    const first = new SeededIdSource(1)
    const second = new SeededIdSource(2)
    expect(Array.from({ length: 4 }, () => first.randomU32())).not.toEqual(
      Array.from({ length: 4 }, () => second.randomU32()),
    )
  })

  it('stamps a uuid7 from its clock', () => {
    const clock = new ManualClock(1_700_000_000)
    const source = new SeededIdSource(7, clock)
    const minted = [source.uuid7(), source.uuid7()]
    clock.advance(0.001)
    minted.push(source.uuid7())
    expect(minted).toEqual(SEED_7_IDS)
    for (const value of minted) expect(value).toMatch(UUID7_RE)
    expect(stampOf(minted[0] ?? '')).toBe(1_700_000_000_000)
  })

  it('depends on the seed alone without a clock', () => {
    expect(new SeededIdSource(9).uuid7()).toBe(new SeededIdSource(9).uuid7())
    expect(stampOf(new SeededIdSource(9).uuid7())).toBe(0)
  })

  // A frozen clock never ticks, so a burst past the counter has to move on by
  // itself; waiting would hang a seeded run forever.
  it('borrows a millisecond when the counter runs out', () => {
    const source = new SeededIdSource(3, new ManualClock(5))
    const values = Array.from({ length: 5000 }, () => source.uuid7())
    expect(values).toEqual([...values].sort())
    expect(new Set(values).size).toBe(values.length)
    expect(stampOf(values.at(-1) ?? '')).toBeGreaterThan(5000)
  })

  it.each([-1, 2 ** 53, 1.5])('refuses the seed %s', (seed) => {
    expect(() => new SeededIdSource(seed)).toThrow(RangeError)
  })
})

describe('randomBelow', () => {
  it('replays across word widths', () => {
    const source = new SeededIdSource(1)
    expect(randomBelow(source, 10)).toBe(0)
    expect(randomBelowBig(source, 2n ** 64n - 1n)).toBe(7093093102422396071n)
    expect(randomBelow(source, 2 ** 32)).toBe(711577048)
  })

  it('stays in bounds', () => {
    const source = new SeededIdSource(11)
    for (const limit of [1, 2, 3, 62, 2 ** 32 - 1, 2 ** 32, 2 ** 40 + 3]) {
      for (let i = 0; i < 50; i++) {
        const value = randomBelow(source, limit)
        expect(value >= 0 && value < limit).toBe(true)
      }
    }
  })

  it.each([0, -3])('refuses the empty range %s', (limit) => {
    expect(() => randomBelow(new SeededIdSource(0), limit)).toThrow(RangeError)
    expect(() => randomBelowBig(new SeededIdSource(0), BigInt(limit))).toThrow(RangeError)
  })
})

describe('shuffle', () => {
  it('replays a permutation', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    shuffle(new SeededIdSource(3), items)
    expect(items).toEqual([6, 2, 3, 8, 9, 0, 1, 5, 7, 4])
  })
})
