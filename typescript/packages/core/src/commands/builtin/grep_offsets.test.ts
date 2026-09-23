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
import {
  decodeLine,
  encodeLine,
  lineOffsets,
  matchOffset,
  MatchOffsets,
  prefixOf,
} from './grep_offsets.ts'

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

describe('matchOffset', () => {
  it('adds the line start in bytes', () => {
    expect(matchOffset(10, 'xéy abc', 4)).toBe(15)
  })

  it('is the line start for a match at the start of a line', () => {
    expect(matchOffset(11, 'abc abc', 0)).toBe(11)
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

describe('decodeLine', () => {
  it('carries one invalid byte as one code unit', () => {
    // A replacing decode reads 0xff as U+FFFD, which is three bytes wide, so
    // every offset past it ran ahead of GNU's.
    expect(decodeLine(new Uint8Array([0xff, 0x61]))).toBe('\udcffa')
  })

  it('leaves valid UTF-8 alone', () => {
    expect(decodeLine(new TextEncoder().encode('café abc'))).toBe('café abc')
  })

  it('round trips through encodeLine', () => {
    const raw = new Uint8Array([0xff, 0x61, 0xc3, 0xa9, 0xfe])
    expect(encodeLine(decodeLine(raw))).toEqual(raw)
  })
})

describe('offsets over a smuggled byte', () => {
  it('counts an invalid byte as one byte of the line start', () => {
    // `\xff` is one byte, so the second line starts at 2 -- GNU's answer for
    // `grep -b a` over `\xff\na\n`, where a replacing decode said 4.
    expect(lineOffsets([decodeLine(new Uint8Array([0xff])), 'a'])).toEqual([0, 2])
  })

  it('counts an invalid byte as one byte inside the line', () => {
    // `grep -bo a` over `\xffa\n` is `1:a` on GNU grep 3.11.
    expect(matchOffset(0, decodeLine(new Uint8Array([0xff, 0x61])), 1)).toBe(1)
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
