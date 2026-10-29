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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { charWidth } from './width.ts'
import { WIDE, ZERO_WIDTH } from './generated/width_data.ts'

const FIXTURE = new URL('../../../../../integ/fixtures/wc/width.json', import.meta.url)

describe('width tables', () => {
  it('match the shared parity fixture range for range', () => {
    // integ/fixtures/wc/width.json is the contract: the python suite
    // (tests/utils/test_width.py) asserts the same ranges, so regenerating
    // one tree without the other fails both.
    const tables = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as {
      zero_width: number[][]
      wide: number[][]
    }
    expect(ZERO_WIDTH.map((r) => [...r])).toEqual(tables.zero_width)
    expect(WIDE.map((r) => [...r])).toEqual(tables.wide)
  })
})

describe('charWidth', () => {
  it.each([
    ['a', 1],
    ['中', 2],
    ['文', 2],
    ['\u{1F600}', 2],
    ['\u0301', 0],
    ['\u1160', 0],
    ['\u11a8', 0],
    ['\u200b', 0],
    ['\ufeff', 0],
    ['\u061c', 0],
    ['\x00', 0],
    ['\b', 0],
    ['\x1b', 0],
    ['\v', 0],
  ])('measures %j as %i columns', (char, expected) => {
    expect(charWidth(char.codePointAt(0) ?? 0)).toBe(expected)
  })

  it.each([['\u00ad'], ['\u0600'], ['\u{110BD}']])(
    'measures the prepended concatenation mark %j as one column',
    (char) => {
      // Cf is not uniformly zero: GNU measures U+00AD and the Arabic number
      // signs as one column. `printf 'a<U+00AD>b' | wc -L` is 3.
      expect(charWidth(char.codePointAt(0) ?? 0)).toBe(1)
    },
  )
})
