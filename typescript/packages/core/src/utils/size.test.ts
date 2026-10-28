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
import { parseLimit } from './size.ts'

describe('parseLimit', () => {
  it.each([
    [1024, 1024],
    ['1024', 1024],
    ['1KB', 1024],
    ['2MB', 2 * 1024 * 1024],
    ['1GB', 1024 * 1024 * 1024],
    [0, 0],
    ['0', 0],
    ['5K', 5 * 1024],
    [' 1g ', 1024 * 1024 * 1024],
    ['\t2Mb\n', 2 * 1024 * 1024],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['8388607G', 8388607 * 2 ** 30],
    [1000.0, 1000],
    ['00000000000000001K', 1024],
    ['0'.repeat(5000) + '1', 1],
  ])('parses %j as %i bytes', (input, expected) => {
    expect(parseLimit(input, 'limit')).toBe(expected)
  })

  it.each([
    ['-5', '"-5"'],
    [-7, '-7'],
    ['+3', '"+3"'],
    ['1_000', '"1_000"'],
    ['5 MB', '"5 MB"'],
    ['1.5MB', '"1.5MB"'],
    [1.5, '1.5'],
    [-1, '-1'],
    [1e-7, '1e-7'],
    [1e21, '1e+21'],
    ['5T', '"5T"'],
    ['5B', '"5B"'],
    ['5abc', '"5abc"'],
    ['', '""'],
    ['MB', '"MB"'],
    ['\u0665', '"\u0665"'],
    ['5\u212a', '"5\u212a"'],
    ['\u00a05', '"\u00a05"'],
    [true, 'true'],
    ['99999999999999999999', '"99999999999999999999"'],
    ['9007199254740992', '"9007199254740992"'],
    [2 ** 53, '9007199254740992'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
    [NaN, 'NaN'],
    ['8388608G', '"8388608G"'],
    [[1, 2], '[1,2]'],
    [{ a: 1 }, '{"a":1}'],
    ['1'.repeat(5000), JSON.stringify('1'.repeat(5000))],
  ])('refuses %j in the one message both hosts give', (input, shown) => {
    expect(() => parseLimit(input as string | number, 'limit')).toThrow(
      new Error(`limit must be a size like 100MB, got ${shown}`),
    )
  })
})
