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
import { RecentChanges } from '../../mount/changes.ts'
import { ManualClock } from '../../utils/clock.ts'
import { ReadBatch } from './read_batch.ts'

const ENC = new TextEncoder()

const batch = (changes: RecentChanges): ReadBatch =>
  new ReadBatch({
    holds: true,
    held: new Map([
      ['/r/a', { followed: '/r/a', data: ENC.encode('a\n') }],
      ['/r/link', { followed: '/r/real', data: ENC.encode('r\n') }],
    ]),
    changes,
    count: changes.count,
  })

describe('ReadBatch', () => {
  // Twin of test_a_held_file_is_handed_out_once.
  it('hands a held file out once', () => {
    const held = batch(new RecentChanges(new ManualClock(), 1))
    expect(held.take('/r/a')).toEqual(ENC.encode('a\n'))
    expect(held.take('/r/a')).toBeNull()
    expect(held.take('/r/other')).toBeNull()
    expect(held.holds).toBe(true)
  })

  // Twin of test_a_change_since_the_reads_drops_what_it_reached: a change to
  // the name the read reached through a link drops it too; one elsewhere drops
  // nothing.
  it('drops what a change since the reads reached', () => {
    const changes = new RecentChanges(new ManualClock(), 1)
    const held = batch(changes)
    changes.note('/r/real')
    changes.note('/r/b')
    expect(held.take('/r/link')).toBeNull()
    expect(held.take('/r/a')).toEqual(ENC.encode('a\n'))
  })

  // Twin of test_a_batch_that_holds_nothing_hands_out_nothing.
  it('hands out nothing from a batch that holds nothing', () => {
    const held = new ReadBatch({ kept: true })
    expect([held.holds, held.take('/r/a')]).toEqual([false, null])
  })
})
