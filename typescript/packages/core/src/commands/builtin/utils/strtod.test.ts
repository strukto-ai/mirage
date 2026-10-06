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
import { STRTOD, strtodDouble, strtodWhole } from './strtod.ts'

function double(text: string): number {
  const found = STRTOD.exec(text)
  if (found === null) throw new Error(`no number in ${text}`)
  return strtodDouble(found)
}

// What glibc's strtod consumes at the front of a word, C locale. Mirrors
// test_strtod.py.
describe('strtod', () => {
  it.each([
    ['  -1.5e3x', '  -1.5e3'],
    ['0x1.8p3 rest', '0x1.8p3'],
    ['0x', '0'],
    ['0x.p1', '0'],
    ['1e', '1'],
    ['1e+', '1'],
    ['.5', '.5'],
    ['5.', '5.'],
    ['INFINITY!', 'INFINITY'],
    ['infinit', 'inf'],
    ['nan(x_1)', 'nan(x_1)'],
    ['nan(', 'nan'],
    ['\t\r\v+3', '\t\r\v+3'],
    ['+.e1', null],
    ['', null],
    ['x1', null],
  ])('reads the longest number at the front of %j', (text, consumed) => {
    expect(STRTOD.exec(text)?.[0] ?? null).toBe(consumed)
  })

  it.each([
    ['3', true],
    [' 3', true],
    ['0x10', true],
    ['3 ', false],
    ['1\r', false],
    ['1.5.2', false],
    ['', false],
  ])('whole %j: %s', (text, whole) => {
    expect(strtodWhole(text) !== null).toBe(whole)
  })

  it.each([
    ['1.5', 1.5],
    ['-0x1.8p1', -3],
    ['0x1p-1074', 5e-324],
    ['0x1p1024', Infinity],
    ['-0x1p1024', -Infinity],
    ['1e400', Infinity],
    ['-inf', -Infinity],
    ['Infinity', Infinity],
  ])('rounds %j once to the nearest double', (text, value) => {
    expect(double(text)).toBe(value)
  })

  it.each(['nan', '-NaN', 'nan(0x1)'])('reads %j as the one quiet NaN', (text) => {
    expect(Number.isNaN(double(text))).toBe(true)
  })
})
