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
  UNINIT,
  ValueKind,
  compare,
  formatNum,
  isTrue,
  looksNumeric,
  num,
  parseNumber,
  strnum,
  text,
  toInt,
  toNum,
  toStr,
} from './value.ts'

describe('awk values', () => {
  it.each([
    ['12', true],
    [' +1.5e3 ', true],
    ['.5', true],
    ['7.', true],
    ['0x1A', false],
    ['1e', false],
    ['', false],
    ['abc', false],
    ['٣', false],
  ])('looksNumeric(%j) is %j', (raw, expected) => {
    expect(looksNumeric(raw)).toBe(expected)
  })

  it('tags only numeric-looking input as strnum', () => {
    expect(strnum('10').kind).toBe(ValueKind.STRNUM)
    expect(strnum('10x').kind).toBe(ValueKind.STR)
    expect(strnum('').kind).toBe(ValueKind.STR)
  })

  it.each([
    ['12abc', 12],
    ['  42  ', 42],
    ['.5x', 0.5],
    ['1e', 1],
    ['0x1A', 0],
    ['abc', 0],
    ['-', 0],
  ])('parseNumber(%j) reads the prefix %j', (raw, expected) => {
    expect(parseNumber(raw)).toBe(expected)
  })

  it.each([
    [17, '17'],
    [-0, '0'],
    [1e6, '1000000'],
    [1e16, '10000000000000000'],
    [2 ** 60, '1152921504606846976'],
    [0.1 + 0.2, '0.3'],
    [1 / 3, '0.333333'],
    [1e-7, '1e-07'],
    [123456789.123, '1.23457e+08'],
    [Infinity, 'inf'],
    [-Infinity, '-inf'],
    [NaN, 'nan'],
  ])('formatNum(%j) is %j', (value, expected) => {
    expect(formatNum(value, '%.6g')).toBe(expected)
  })

  it('honours CONVFMT and survives a bad one', () => {
    expect(formatNum(3.14159, '%.2f')).toBe('3.14')
    expect(formatNum(3.14159, '%d')).toBe('3.14159')
    expect(formatNum(3.14159, 'junk')).toBe('3.14159')
  })

  it('truncates and clamps toInt', () => {
    expect(toInt(3.9)).toBe(3n)
    expect(toInt(-3.9)).toBe(-3n)
    expect(toInt(NaN)).toBe(0n)
    expect(toInt(Infinity)).toBe(2n ** 63n)
    expect(toInt(-Infinity)).toBe(-(2n ** 63n))
  })

  it('reads uninit as zero and empty', () => {
    expect(toNum(UNINIT)).toBe(0)
    expect(toStr(UNINIT, '%.6g')).toBe('')
    expect(isTrue(UNINIT)).toBe(false)
  })

  it('judges truthiness', () => {
    expect(isTrue(num(1))).toBe(true)
    expect(isTrue(num(0))).toBe(false)
    expect(isTrue(text('0'))).toBe(true)
    expect(isTrue(strnum('0'))).toBe(false)
    expect(isTrue(text(''))).toBe(false)
  })

  it('compares numerically only between numeric kinds', () => {
    expect(compare(strnum('10'), num(9), '%.6g')).toBe(1)
    expect(compare(text('10'), num(9), '%.6g')).toBe(-1)
    expect(compare(UNINIT, num(0), '%.6g')).toBe(0)
    expect(compare(text(''), num(0), '%.6g')).toBe(-1)
    expect(compare(text('abc'), text('abd'), '%.6g')).toBe(-1)
  })
})
