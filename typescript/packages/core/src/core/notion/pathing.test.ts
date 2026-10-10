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
import { parseIdName } from '../../utils/naming.ts'
import { formatSegment, sanitizeName } from './pathing.ts'
import { NAME_MAX_BYTES, byteLength } from '../../utils/sanitize.ts'

describe('sanitizeName', () => {
  it('replaces spaces with underscores', () => {
    expect(sanitizeName('Hello World')).toBe('Hello_World')
  })
  it('replaces unsafe characters with underscores and collapses runs', () => {
    expect(sanitizeName("a/b's c")).toBe('a_b_s_c')
  })
  it('keeps dashes and dots', () => {
    expect(sanitizeName('v1.2-final')).toBe('v1.2-final')
  })
  it('strips leading and trailing underscores', () => {
    expect(sanitizeName('!keep!')).toBe('keep')
  })
  it('returns "unknown" for blank input', () => {
    expect(sanitizeName('   ')).toBe('unknown')
  })
  it('truncates to 100 characters', () => {
    expect(sanitizeName('x'.repeat(150))).toHaveLength(100)
  })
})

describe('formatSegment', () => {
  it('joins sanitized title and raw id with double underscore', () => {
    expect(formatSegment({ id: 'aaaa1111-2222-3333-4444-555566667777', title: 'My Page' })).toBe(
      'My_Page__aaaa1111-2222-3333-4444-555566667777',
    )
  })
  it('uses "untitled" when the title is empty', () => {
    expect(formatSegment({ id: 'aaaa1111-2222-3333-4444-555566667777', title: '' })).toBe(
      'untitled__aaaa1111-2222-3333-4444-555566667777',
    )
  })
})

describe('formatSegment round-trip', () => {
  it('round-trips a sanitized title', () => {
    const page = { id: 'aaaa1111-2222-3333-4444-555566667777', title: 'My_Page' }
    expect(parseIdName(formatSegment(page))).toEqual([page.title, page.id])
  })
  it('round-trips a title containing double underscore in the middle', () => {
    expect(parseIdName('a__b__aaaa1111-2222-3333-4444-555566667777')).toEqual([
      'a__b',
      'aaaa1111-2222-3333-4444-555566667777',
    ])
  })
})

describe('formatSegment byte budget', () => {
  const CJK_TITLE = '会議'.repeat(100)
  const OBJ_ID = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789'

  it('fits NAME_MAX and still addresses the id', () => {
    const name = formatSegment({ id: OBJ_ID, title: CJK_TITLE })

    expect(byteLength(name)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(parseIdName(name)[1]).toBe(OBJ_ID)
    expect(name).not.toContain('\uFFFD')
  })
})
