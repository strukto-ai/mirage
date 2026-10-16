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
import { affectedTs, channelIdOf, dayOf, messageTs } from './payload.ts'

// 2025-08-15T23:30:00Z is 4:30pm PDT the same day, so client and mount
// agree; 2025-08-16T05:00:00Z is 10pm PDT on the 15th, where they do not.
const TS = '1755300600.000100'
const LATE = '1755320400.000100'

describe('dayOf', () => {
  it('buckets in UTC', () => {
    expect(dayOf(TS)).toBe('2025-08-15')
    expect(dayOf(LATE)).toBe('2025-08-16')
  })

  it('rejects a non-numeric ts', () => {
    expect(dayOf('not-a-ts')).toBeNull()
  })

  it('rejects an empty ts rather than bucketing it into 1970', () => {
    expect(dayOf('')).toBeNull()
    expect(dayOf('  ')).toBeNull()
  })
})

describe('messageTs', () => {
  it('prefers the deleted message', () => {
    expect(messageTs({ subtype: 'message_deleted', ts: LATE, deleted_ts: TS })).toBe(TS)
  })

  it('falls back to the previous message', () => {
    expect(messageTs({ subtype: 'message_deleted', ts: LATE, previous_message: { ts: TS } })).toBe(
      TS,
    )
  })

  it('prefers the edited message', () => {
    expect(messageTs({ subtype: 'message_changed', ts: LATE, message: { ts: TS } })).toBe(TS)
  })

  it("is the event's own ts by default", () => {
    expect(messageTs({ ts: TS })).toBe(TS)
  })
})

describe('channelIdOf', () => {
  it('reads a bare id', () => {
    expect(channelIdOf({ channel: 'C0288' })).toBe('C0288')
  })

  it('reads a channel object', () => {
    expect(channelIdOf({ channel: { id: 'C0288' } })).toBe('C0288')
  })

  it('reads neither', () => {
    expect(channelIdOf({ user: { id: 'U1' } })).toBeNull()
  })
})

describe('affectedTs', () => {
  it('affects its own day for a plain message', () => {
    expect(affectedTs({ ts: TS })).toEqual([TS])
  })

  it('affects its own day for a thread parent', () => {
    expect(affectedTs({ ts: TS, thread_ts: TS })).toEqual([TS])
  })

  it("affects the parent's day, not its own, for a thread reply", () => {
    // chat.jsonl renders conversations.history, which returns parents
    // only, so the reply is in no day file. The parent's reply_count is.
    expect(affectedTs({ ts: LATE, thread_ts: TS })).toEqual([TS])
  })

  it('affects both days for a broadcast reply', () => {
    expect(affectedTs({ ts: LATE, thread_ts: TS, subtype: 'thread_broadcast' })).toEqual([TS, LATE])
  })

  it('affects both days for a reply_broadcast flag', () => {
    expect(affectedTs({ ts: LATE, thread_ts: TS, reply_broadcast: true })).toEqual([TS, LATE])
  })

  it("affects the parent's day for a deleted reply", () => {
    expect(
      affectedTs({
        subtype: 'message_deleted',
        ts: '1755400000.0',
        deleted_ts: LATE,
        previous_message: { ts: LATE, thread_ts: TS },
      }),
    ).toEqual([TS])
  })

  it("affects the parent's day for an edited reply", () => {
    expect(
      affectedTs({
        subtype: 'message_changed',
        ts: '1755400000.0',
        message: { ts: LATE, thread_ts: TS },
      }),
    ).toEqual([TS])
  })

  it('affects nothing without a ts', () => {
    expect(affectedTs({ channel: 'C1' })).toEqual([])
  })
})
