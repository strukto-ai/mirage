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
import { makeFilename } from './slide_entry.ts'
import { NAME_MAX_BYTES, byteLength } from '../../utils/sanitize.ts'

// A real Google file id is 44 characters, so this is the fixed overhead a
// title actually has to fit inside.
const DOC_ID = '1'.repeat(44)

describe('gslides presentation filenames', () => {
  it('leads with the date when there is one', () => {
    expect(makeFilename('My Presentation', 'abc123', '2026-03-15T10:00:00Z')).toBe(
      '2026-03-15_My_Presentation__abc123.gslide.json',
    )
    expect(makeFilename('My Presentation', 'abc123')).toBe('My_Presentation__abc123.gslide.json')
  })

  it('fits NAME_MAX for a CJK title', () => {
    // 100 characters of CJK is 300 bytes, which the character budget passed
    // untouched: with the date, the id and the suffix the name came to 367
    // bytes and ext4/APFS reject it with ENAMETOOLONG.
    const name = makeFilename('会議の記録'.repeat(40), DOC_ID, '2026-08-20T12:00:00Z')
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name.startsWith('2026-08-20_')).toBe(true)
    expect(name.endsWith(`__${DOC_ID}.gslide.json`)).toBe(true)
    // The cut lands on a character boundary, never mid-sequence.
    expect(name).not.toContain('\uFFFD')
  })

  it('leaves an ascii title on the character budget', () => {
    const name = makeFilename('a'.repeat(400), DOC_ID, '')
    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(name).toBe(`${'a'.repeat(97)}...__${DOC_ID}.gslide.json`)
  })

  it('keeps the id when it leaves no room', () => {
    // The title is what gives, never the id: a trimmed id would stop
    // addressing the presentation. Same rule as gcal's event filenames.
    const longId = 'v'.repeat(NAME_MAX_BYTES - 4)
    expect(makeFilename('Some Title', longId, '')).toContain(`__${longId}.gslide.json`)
  })
})
