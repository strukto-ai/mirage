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
  matchPosition,
  nextRandom,
  safeFmod,
  safeLog,
  safePow,
  safeSqrt,
  splitRecord,
  sprintf,
  substitute,
  substr,
  takeRecord,
} from './builtins.ts'
import { AwkRuntimeError, AwkSyntaxError } from './errors.ts'
import { num, strnum, text, type Value } from './value.ts'

describe('awk substr', () => {
  it.each<[number, number | null, string]>([
    [1, 5, 'hello'],
    [7, null, 'world'],
    [0, 3, 'hel'],
    [-1, 3, 'hel'],
    [5, 100, 'o world'],
    [20, null, ''],
    [2.7, 2.5, 'el'],
    [1, 0, ''],
    [NaN, 2, 'he'],
  ])('substr("hello world", %j, %j) is %j', (start, length, expected) => {
    expect(substr('hello world', start, length)).toBe(expected)
  })

  it('counts characters, not code units', () => {
    expect(substr('héllo', 2, 2)).toBe('él')
    expect(substr('a😀b', 2, 1)).toBe('😀')
  })
})

describe('awk sub and gsub', () => {
  it.each<[string, string, string, boolean, [number, string]]>([
    ['o', '0', 'foo boo', true, [4, 'f00 b00']],
    ['o', '0', 'foo boo', false, [1, 'f0o boo']],
    ['a', '[&]', 'aaa', false, [1, '[a]aa']],
    ['\\.', '\\&', 'a.b.c', true, [2, 'a&b&c']],
    ['l*', '-', 'hello', true, [4, '-h-e-o-']],
    ['x*', '-', '', true, [1, '-']],
    ['z', 'y', 'abc', true, [0, 'abc']],
    ['b', '\\\\', 'abc', true, [1, 'a\\\\c']],
    ['b', '\\\\&', 'abc', true, [1, 'a\\bc']],
    ['b', 'x\\y', 'abc', true, [1, 'ax\\yc']],
  ])('substitute(%j, %j, %j, %j)', (pattern, template, subject, globally, expected) => {
    expect(substitute(pattern, template, subject, globally)).toEqual(expected)
  })

  it('locates a match in characters', () => {
    expect(matchPosition('o+', 'foobar')).toEqual([2, 2])
    expect(matchPosition('y', 'x')).toEqual([0, -1])
    expect(matchPosition('l+', 'héllo')).toEqual([3, 2])
  })
})

describe('awk field splitting', () => {
  it.each<[string, string, string[]]>([
    ['  a  b\tc \n', ' ', ['a', 'b', 'c']],
    ['', ' ', []],
    ['a:b::c', ':', ['a', 'b', '', 'c']],
    ['a1b22c', '[0-9]+', ['a', 'b', 'c']],
    ['a.b', '.', ['a', 'b']],
    ['a|b', '|', ['a', 'b']],
    ['a b\tc d', '\t', ['a b', 'c d']],
    ['abc', '', ['a', 'b', 'c']],
    ['', ':', []],
    ['abc', 'x*', ['abc']],
  ])('splitRecord(%j, %j)', (record, separator, expected) => {
    expect(splitRecord(record, separator)).toEqual(expected)
  })

  it.each<[string, string, string[]]>([
    ['a:b\nc', ':', ['a', 'b', 'c']],
    ['a b\nc', ' ', ['a', 'b', 'c']],
    ['a\tb\nc', '\t', ['a', 'b', 'c']],
    ['a:b\nc', '[:]', ['a', 'b\nc']],
  ])('splitRecord(%j, %j) in paragraph mode', (record, separator, expected) => {
    expect(splitRecord(record, separator, true)).toEqual(expected)
  })
})

function drain(buffer: string, separator: string, final: boolean): [string[], number] {
  const records: string[] = []
  let start = 0
  for (;;) {
    const [record, next] = takeRecord(buffer, start, separator, final)
    start = next
    if (record === null) return [records, start]
    records.push(record)
  }
}

describe('awk record splitting', () => {
  it.each<[string, string, string[]]>([
    ['a\nb\n', '\n', ['a', 'b']],
    ['a\n\nb', '\n', ['a', '', 'b']],
    ['a:b', ':', ['a', 'b']],
    ['a:b:\n', ':', ['a', 'b', '\n']],
    ['a:b:', ':', ['a', 'b']],
    ['a.b|c', '.', ['a', 'b|c']],
    ['a😀b', '😀', ['a', 'b']],
    ['\n\na b\nc\n\n\n\nd e\n\n', '', ['a b\nc', 'd e']],
    ['a\n \nb\n', '', ['a\n \nb']],
    ['a\n \n', '', ['a\n ']],
    ['\n\n\n', '', []],
    ['', '', []],
    ['a12b345c', '[0-9]+', ['a', 'b', 'c']],
    ['a12b34', '[0-9]+', ['a', 'b']],
    ['axxbyc', 'x*', ['a', 'byc']],
    ['a;b,c', ';|,', ['a', 'b', 'c']],
  ])('takeRecord(%j, %j) at the end of input', (buffer, separator, expected) => {
    expect(drain(buffer, separator, true)).toEqual([expected, buffer.length])
  })

  it.each<[string, string, string[], string]>([
    ['a\nb', '\n', ['a'], 'b'],
    ['a\n\nb\n', '', ['a'], 'b\n'],
    ['a\n\n', '', [], 'a\n\n'],
    ['a\n', '', [], 'a\n'],
    ['a12', '[0-9]+', [], 'a12'],
    ['a12b', '[0-9]+', ['a'], 'b'],
    ['ab', 'x*', [], 'ab'],
  ])(
    'takeRecord(%j, %j) waits for a separator that could grow',
    (buffer, separator, expected, rest) => {
      const [records, start] = drain(buffer, separator, false)
      expect(records).toEqual(expected)
      expect(buffer.slice(start)).toBe(rest)
    },
  )

  it('is a syntax error on a bad regex', () => {
    expect(() => takeRecord('ab', 0, '[a', true)).toThrow(AwkSyntaxError)
  })
})

describe('awk sprintf', () => {
  const n42 = num(42)
  it.each<[string, Value[], string]>([
    ['%d|%5d|%-5d|%05d|%+d|% d', [n42, n42, n42, n42, n42, n42], '42|   42|42   |00042|+42| 42'],
    [
      '%s|%10s|%-10s|%.2s',
      [text('hi'), text('hi'), text('hi'), text('hello')],
      'hi|        hi|hi        |he',
    ],
    ['%f|%.2f|%10.3f', [num(3.14159), num(3.14159), num(3.14159)], '3.141590|3.14|     3.142'],
    [
      '%e|%.3e|%g|%G',
      [num(31415.9), num(31415.9), num(0.00001234), num(1e20)],
      '3.141590e+04|3.142e+04|1.234e-05|1E+20',
    ],
    ['%x|%X|%o|%#x|%#o', [num(255), num(255), num(8), num(255), num(8)], 'ff|FF|10|0xff|010'],
    ['%c|%c|%%', [num(65), text('hello')], 'A|h|%'],
    ['%d %d %d', [num(-3.9), strnum('12abc'), text('abc')], '-3 12 0'],
    ['%*d|%-*d|%.*f', [num(5), n42, num(5), n42, num(2), num(3.14159)], '   42|42   |3.14'],
    ['%x', [num(-1)], 'ffffffffffffffff'],
    ['%d', [num(2 ** 70)], '1180591620717411303424'],
    ['%.3d|%.0d', [num(7), num(0)], '007|'],
    ['%5%|%z', [], '%5%|%z'],
    ['100%', [], '100%'],
  ])('sprintf(%j)', (fmt, args, expected) => {
    expect(sprintf(fmt, args, '%.6g')).toBe(expected)
  })

  it('is fatal with too few arguments', () => {
    expect(() => sprintf('%s %s', [text('only')], '%.6g')).toThrow(AwkRuntimeError)
    expect(() => sprintf('%s %s', [text('only')], '%.6g')).toThrow('not enough arguments')
  })
})

describe('awk math', () => {
  it('answers the edges like C', () => {
    expect(safeLog(0)).toBe(-Infinity)
    expect(safeLog(-1)).toBeNaN()
    expect(safeSqrt(-1)).toBeNaN()
    expect(safePow(0, -1)).toBe(Infinity)
    expect(safePow(-10, 1001)).toBe(-Infinity)
    expect(safePow(-8, 0.5)).toBeNaN()
    expect(safePow(2, 10)).toBe(1024)
    expect(safePow(1, NaN)).toBe(1)
    expect(safePow(-1, Infinity)).toBe(1)
    expect(safeFmod(Infinity, 2)).toBeNaN()
    expect(safeFmod(-7, 3)).toBe(-1)
  })

  it('draws the same rand sequence as the Python host', () => {
    let state = 0
    const drawn: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const [next, value] = nextRandom(state)
      state = next
      drawn.push(value)
    }
    expect(drawn).toEqual([0.26642920868471265, 0.0003297457005828619, 0.2232720274478197])
  })
})
