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
import { boundedDecimal, cInt, strtol, strtoul, signedDecimal, unsignedDecimal } from './strtol.ts'

// Mirrors python/tests/commands/builtin/utils/test_strtol.py.
describe('strtol', () => {
  it.each([
    ['2', 2n, ''],
    ['0x2', 2n, ''],
    ['017', 15n, ''],
    ['2k', 2n, 'k'],
    ['x', 0n, 'x'],
    ['08', 0n, '8'],
    ['-3', -3n, ''],
    [' +4', 4n, ''],
    ['99999999999999999999', 2n ** 63n - 1n, ''],
    ['-99999999999999999999', -(2n ** 63n), ''],
  ])('strtol %j', (raw, value, rest) => {
    expect(strtol(raw)).toEqual([value, rest])
  })

  it.each([
    ['', 0n, ''],
    ['0x10', 16n, ''],
    ['-1', 2n ** 64n - 1n, ''],
    ['99999999999999999999', 2n ** 64n - 1n, ''],
    ['3x', 3n, 'x'],
    ['  ', 0n, '  '],
  ])('strtoul %j', (raw, value, rest) => {
    expect(strtoul(raw)).toEqual([value, rest])
  })

  it.each([
    ['5', 5n, 5n],
    [' \t+5', 5n, 5n],
    ['-5', null, -5n],
    ['5 ', null, null],
    ['0x5', null, null],
    ['', null, null],
    ['+ 5', null, null],
    ['99999999999999999999', 99999999999999999999n, 99999999999999999999n],
  ])('whole decimal word %j', (raw, unsigned, signed) => {
    expect(unsignedDecimal(raw)).toBe(unsigned)
    expect(signedDecimal(raw)).toBe(signed)
  })

  it('cInt keeps the low 32 bits signed', () => {
    expect(cInt(2n ** 32n + 1n)).toBe(1n)
    expect(cInt(2n ** 64n - 1n)).toBe(-1n)
    expect(cInt(2n ** 31n)).toBe(-(2n ** 31n))
  })
})

describe('a number past any digit limit', () => {
  it('scans exactly or saturates as the C reader does', () => {
    const digits = '9'.repeat(5000)
    expect(unsignedDecimal(digits)).toBe(10n ** 5000n - 1n)
    expect(signedDecimal(`-${digits}`)).toBe(-(10n ** 5000n - 1n))
    expect(strtol(digits)).toEqual([2n ** 63n - 1n, ''])
    expect(strtoul(digits)).toEqual([2n ** 64n - 1n, ''])
  })
})

describe('boundedDecimal', () => {
  it.each([
    ['', 10n, 0n],
    ['18446744073709551614', 2n ** 64n - 1n, 2n ** 64n - 2n],
    ['0018446744073709551615', 2n ** 64n - 1n, null],
    ['100', 100n, null],
    ['099', 100n, 99n],
  ])('reads %s under %s, refusing the bound and past', (digits, bound, value) => {
    expect(boundedDecimal(digits, bound)).toBe(value)
  })

  it('reads past any digit limit', () => {
    expect(boundedDecimal('0'.repeat(5000) + '1', 2n ** 64n - 1n)).toBe(1n)
    expect(boundedDecimal('0'.repeat(5000), 10n)).toBe(0n)
    expect(boundedDecimal('9'.repeat(5000), 2n ** 64n - 1n)).toBeNull()
  })
})
