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
import { NAME_MAX_BYTES } from '../../utils/sanitize.ts'
import {
  PRIMARY_DIR,
  eventTitle,
  makeCalendarDirname,
  makeEventFilename,
  parseCalendarDirname,
  parseEventFilename,
} from './event_entry.ts'

const EVENT_ID = 'la9i1t995acovthi3f761chla0'
const UTF8 = new TextEncoder()

function byteLength(value: string): number {
  return UTF8.encode(value).length
}

describe('gcal event entry naming', () => {
  it('leads with the id', () => {
    const name = makeEventFilename(EVENT_ID, '0900-1030', 'PhD_Defense')
    expect(name).toBe(`${EVENT_ID}__0900-1030_PhD_Defense.gcal.json`)
    expect(parseEventFilename(name)).toEqual([EVENT_ID, '0900-1030'])
  })

  it('round trips a title holding underscores', () => {
    const name = makeEventFilename(EVENT_ID, '1500-1600', 'A__B_C')
    expect(parseEventFilename(name)).toEqual([EVENT_ID, '1500-1600'])
  })

  it('rejects a non-event name', () => {
    expect(() => parseEventFilename('notes.txt')).toThrow()
    expect(() => parseEventFilename('noseparator.gcal.json')).toThrow()
    expect(() => parseEventFilename(`${EVENT_ID}__090.gcal.json`)).toThrow()
  })

  it('trims a long ascii title to NAME_MAX', () => {
    const name = makeEventFilename(EVENT_ID, '0900-1030', 'a'.repeat(400))
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(parseEventFilename(name)).toEqual([EVENT_ID, '0900-1030'])
  })

  it('trims a long CJK title by bytes, not characters', () => {
    // 3 bytes per character: a character-counted budget would overflow
    // NAME_MAX, which is the bug gdocs' sanitizeTitle still has.
    const name = makeEventFilename(EVENT_ID, '0900-1030', '会'.repeat(200))
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).not.toContain('�')
    expect(parseEventFilename(name)).toEqual([EVENT_ID, '0900-1030'])
  })

  it('drops the title when a long id leaves no room', () => {
    // 234 is the widest id that still names an event: the title is
    // squeezed out entirely and id + separators + suffix lands exactly on
    // NAME_MAX.
    const longId = 'v'.repeat(234)
    const name = makeEventFilename(longId, '0900-1030', 'Some_Title')
    expect(byteLength(name)).toBe(NAME_MAX_BYTES)
    expect(name).toBe(`${longId}__0900-1030.gcal.json`)
    expect(parseEventFilename(name)).toEqual([longId, '0900-1030'])
  })

  it('keeps an id too long to name rather than truncating it', () => {
    // The title is what gives, never the id: a trimmed id would stop
    // addressing the event. Real Google ids are 26 chars, so this only
    // arises for a caller-supplied events.import id.
    const longId = 'v'.repeat(NAME_MAX_BYTES - 20)
    const name = makeEventFilename(longId, '0900-1030', 'Some Title')
    expect(byteLength(name)).toBeGreaterThan(NAME_MAX_BYTES)
    expect(parseEventFilename(name)).toEqual([longId, '0900-1030'])
  })

  it('falls back by access role', () => {
    expect(eventTitle('Standup')).toBe('Standup')
    expect(eventTitle(null)).toBe('untitled')
    expect(eventTitle('   ')).toBe('untitled')
    expect(eventTitle(null, true)).toBe('busy')
  })

  it('keeps the primary alias', () => {
    expect(makeCalendarDirname('integ@example.com', 'integ@example.com', true)).toBe(PRIMARY_DIR)
    expect(parseCalendarDirname(PRIMARY_DIR)).toBe(PRIMARY_DIR)
  })

  it('embeds the calendar id verbatim', () => {
    const calId = 'en.usa#holiday@group.v.calendar.google.com'
    const name = makeCalendarDirname('US Holidays', calId)
    expect(name).toBe(`US_Holidays__${calId}`)
    expect(parseCalendarDirname(name)).toBe(calId)
  })

  it('rejects a calendar dirname without an id', () => {
    expect(() => parseCalendarDirname('Engineering')).toThrow()
  })
})
