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
import { lineOffsets, MatchOffsets, prefixOf, rgPieces, rustMatches } from './grep_offsets.ts'
import { decodeText } from '../../shell/bytes.ts'

describe('lineOffsets', () => {
  it('counts the terminator the line iterator strips', () => {
    // abc\ndefabc\nabc abc\n -- section Q1 of the GNU truth file.
    expect(lineOffsets(['abc', 'defabc', 'abc abc'])).toEqual([0, 4, 11])
  })

  it('counts bytes rather than characters', () => {
    // `caf` + U+00E9 (two bytes) + a space is six bytes, so line two starts
    // at 10 rather than at the code-unit index 9.
    expect(lineOffsets(['café abc', 'xéy abc'])).toEqual([0, 10])
  })

  it('does not read past the last line', () => {
    // A file with no final newline still reports 0 for its one line; the
    // extra byte the accumulator adds is never read.
    expect(lineOffsets(['no-newline-abc'])).toEqual([0])
  })

  it('is empty for no lines', () => {
    expect(lineOffsets([])).toEqual([])
  })
})

describe('prefixOf', () => {
  it('puts the line number before the byte offset', () => {
    expect(prefixOf(2, 4)).toBe('2:4:')
  })

  it('omits a field that is off', () => {
    expect([prefixOf(2, null), prefixOf(null, 4)]).toEqual(['2:', '4:'])
  })

  it('is empty when neither flag is set', () => {
    expect(prefixOf(null, null)).toBe('')
  })

  it('renders a context line with dashes throughout', () => {
    expect(prefixOf(3, 12, false)).toBe('3-12-')
  })
})

describe('offsets over a smuggled byte', () => {
  it('counts an invalid byte as one byte of the line start', () => {
    // `\xff` is one byte, so the second line starts at 2 -- GNU's answer for
    // `grep -b a` over `\xff\na\n`, where a replacing decode said 4.
    expect(lineOffsets([decodeText(new Uint8Array([0xff])), 'a'])).toEqual([0, 2])
  })
})

it('advances through Unicode and escaped bytes without recounting prefixes', () => {
  const offsets = new MatchOffsets(10, 'é😀a\udcffé😀a')
  expect([offsets.at(3), offsets.at(8)]).toEqual([16, 24])
})

it('keeps surrogate pairs intact between non-Unicode regex matches', () => {
  const offsets = new MatchOffsets(0, '𐂀😀x')
  expect([0, 1, 2, 3, 4].map((index) => offsets.at(index))).toEqual([0, 3, 4, 7, 8])
})

describe('rustMatches', () => {
  it('resumes one character after an empty match', () => {
    // `rg -o 'x*'` over `abc` prints four empty lines on ripgrep 14.1.1.
    expect(rustMatches(/x*/, 'abc')).toEqual([
      [0, ''],
      [1, ''],
      [2, ''],
      [3, ''],
    ])
  })

  it('skips an empty match where a match ended', () => {
    // `rg -o 'b*'` over `abc` is an empty line, `b`, an empty line.
    expect(rustMatches(/b*/, 'abc')).toEqual([
      [0, ''],
      [1, 'b'],
      [3, ''],
    ])
  })

  it('skips it after every non-empty match', () => {
    // `rg -o '[0-9]*'` over `1a22b` prints `1`, `22` and an empty line.
    expect(rustMatches(/[0-9]*/, '1a22b')).toEqual([
      [0, '1'],
      [2, '22'],
      [5, ''],
    ])
  })

  it('takes the first alternative that matches', () => {
    // `rg -o 'o|'` over `foo` is an empty line, `o`, `o`.
    expect(rustMatches(/o|/, 'foo')).toEqual([
      [0, ''],
      [1, 'o'],
      [2, 'o'],
    ])
  })

  it('sees the text before where it resumes', () => {
    // `rg -o '\b'` over `ab` is two empty lines: no boundary inside `ab`.
    expect(rustMatches(/\b/, 'ab')).toEqual([
      [0, ''],
      [2, ''],
    ])
  })

  it('anchors only at the line start', () => {
    // `rg -o '^'` over `ab` is one empty line.
    expect(rustMatches(/^/, 'ab')).toEqual([[0, '']])
  })

  it('steps over a surrogate pair as one character', () => {
    expect(rustMatches(/x*/, 'é😀')).toEqual([
      [0, ''],
      [1, ''],
      [3, ''],
    ])
  })

  it('ignores the global and sticky state of the pattern it is given', () => {
    const pat = /a/gy
    pat.lastIndex = 2
    expect(rustMatches(pat, 'aba')).toEqual([
      [0, 'a'],
      [2, 'a'],
    ])
  })

  it('is empty for no match', () => {
    expect(rustMatches(/y/, 'x')).toEqual([])
  })
})

describe('rgPieces', () => {
  it('is the matches when there are any', () => {
    expect(rgPieces(/[0-9]/, 'a1b2c')).toEqual([
      [1, '1'],
      [3, '2'],
    ])
  })

  it('prints a line without a match whole', () => {
    // `rg -ov y` over `x` prints `x`, as a context line under -o prints.
    expect(rgPieces(/y/, 'x')).toEqual([[0, 'x']])
  })
})
