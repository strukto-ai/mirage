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
import { STRTOD, strtodDouble, strtodWhole, strtoldErange } from './strtod.ts'

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

  // Where glibc's strtold reports ERANGE for a binary128 long double, pinned
  // with bash 5.2.37's printf: when the value rounds past the largest finite
  // one, and when it is under the least normal one and off the subnormal
  // grid, judged before rounding. Mirrors test_strtod.py.
  it.each([
    ['1e400', false],
    ['1.1e4932', false],
    ['1.2e4932', true],
    ['4e-4932', false],
    ['3e-4932', true],
    ['1e-4970', true],
    ['0e99999', false],
    ['0x1.8p16383', false],
    ['0x1p99999', true],
    ['0x1p-16400', false],
    ['-inf', false],
    ['1.18973149535723176508575932662800703e4932', false],
    ['1.18973149535723176508575932662800708e4932', true],
    ['0x1.fffffffffffffffffffffffffffffp16383', true],
    ['0x1.ffffffffffffffffffffffffffff8p16383', true],
    ['3.3621031431120935062626778173217525e-4932', true],
    ['1e' + '9'.repeat(5000), true],
    ['1e' + '0'.repeat(5000) + '1', false],
    // 2**-16400 spelled out in decimal: a subnormal held exactly.
    [`${(5n ** 16400n).toString()}e-16400`, false],
    ['1'.repeat(20000) + 'e-15067', false],
    ['3.3621031431120935062626778173217526' + '0'.repeat(20000) + '1e-4932', true],
    ['0x1.' + 'f'.repeat(20000) + 'p16383', true],
  ])('marks %s out of a long double range: %j', (text, erange) => {
    const found = STRTOD.exec(text)
    if (found === null) throw new Error(`no number in ${text}`)
    expect(strtoldErange(found)).toBe(erange)
  })
})
