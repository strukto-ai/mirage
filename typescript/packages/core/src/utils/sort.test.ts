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
import { compareCodePoints, sortedByCodePoints } from './sort.ts'

// U+E000 is a BMP private-use character; U+1F600 is astral, stored as the
// surrogate pair D83D DE00. Code-point order puts E000 first, UTF-16 code
// unit order puts D83D first. This is issue #370 in two characters.
const BMP = ''
const ASTRAL = '\u{1F600}'

describe('compareCodePoints', () => {
  it('puts a BMP character above U+E000 before an astral one', () => {
    expect(compareCodePoints(BMP, ASTRAL)).toBeLessThan(0)
  })

  it('disagrees with the default comparator on exactly that pair', () => {
    // The assertion that would have failed before the fix: proof the
    // divergence is real rather than theoretical.
    expect([ASTRAL, BMP].sort(compareCodePoints)).toEqual([BMP, ASTRAL])
    expect([ASTRAL, BMP].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([ASTRAL, BMP])
  })

  it('matches Python: sorted(["\\ue000.txt", "\\U0001f600.txt"])', () => {
    expect(sortedByCodePoints([`${ASTRAL}.txt`, `${BMP}.txt`])).toEqual([
      `${BMP}.txt`,
      `${ASTRAL}.txt`,
    ])
  })

  it('orders plain ASCII the way it always did', () => {
    expect(sortedByCodePoints(['b', 'a', 'C', 'A'])).toEqual(['A', 'C', 'a', 'b'])
  })

  it('treats a prefix as smaller than the string extending it', () => {
    expect(compareCodePoints('a', 'ab')).toBeLessThan(0)
    expect(compareCodePoints('ab', 'a')).toBeGreaterThan(0)
  })

  it('is zero only for equal strings', () => {
    expect(compareCodePoints('same', 'same')).toBe(0)
    expect(compareCodePoints('', '')).toBe(0)
    expect(compareCodePoints('', 'a')).toBeLessThan(0)
  })

  it('walks past an astral character to compare what follows', () => {
    expect(compareCodePoints(`${ASTRAL}a`, `${ASTRAL}b`)).toBeLessThan(0)
    expect(compareCodePoints(`${ASTRAL}b`, `${ASTRAL}a`)).toBeGreaterThan(0)
  })

  it('orders two astral characters by code point', () => {
    expect(sortedByCodePoints(['\u{1F601}', '\u{1F600}', '\u{10000}'])).toEqual([
      '\u{10000}',
      '\u{1F600}',
      '\u{1F601}',
    ])
  })

  it('copies rather than sorting the caller in place', () => {
    const names = ['b', 'a']
    expect(sortedByCodePoints(names)).toEqual(['a', 'b'])
    expect(names).toEqual(['b', 'a'])
  })
})
