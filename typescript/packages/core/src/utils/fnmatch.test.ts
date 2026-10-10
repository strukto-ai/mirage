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
import { fnmatch, fnmatchcase } from './fnmatch.ts'

const NAMES = [
  '',
  'a',
  'b',
  'd',
  '!',
  '-',
  '^',
  'ab',
  'xx',
  'z',
  'a.txt',
  'A.TXT',
  'a.txt.bak',
  '.hidden',
  'a/b',
  'a\nb',
  '[abc]',
  'a{2}',
  'x+y',
  '[',
  '[ab',
  'file5',
  'fileX',
  'a-b',
  'axb',
  ']',
]

// Generated against CPython fnmatch.fnmatchcase. Regenerate by running each
// pattern through python3: [n for n in NAMES if fnmatch.fnmatchcase(n, pattern)]
// Deliberate divergence from CPython: a leading ^ negates a class like !
// does (bash/glibc semantics), so [^abc] rows differ from fnmatchcase.
const GOLDEN: [string, string[]][] = [
  ['*', NAMES],
  ['?', ['a', 'b', 'd', '!', '-', '^', 'z', '[', ']']],
  ['', ['']],
  ['a.txt', ['a.txt']],
  ['*.txt', ['a.txt']],
  ['a?txt*', ['a.txt', 'a.txt.bak']],
  ['a*b', ['ab', 'a/b', 'a\nb', 'a-b', 'axb']],
  ['**', NAMES],
  ['[abc]', ['a', 'b']],
  ['[!abc]', ['d', '!', '-', '^', 'z', '[', ']']],
  ['[a-z]', ['a', 'b', 'd', 'z']],
  ['[!a-z]', ['!', '-', '^', '[', ']']],
  ['[a-]', ['a', '-']],
  ['[-a]', ['a', '-']],
  ['[]a]', ['a', ']']],
  ['[!]a]', ['b', 'd', '!', '-', '^', 'z', '[']],
  ['[z-a]', []],
  ['[', ['[']],
  ['[ab', ['[ab']],
  ['a[xy]b', ['axb']],
  ['a{2}', ['a{2}']],
  ['x+y', ['x+y']],
  ['[^abc]', ['d', '!', '-', '^', 'z', '[', ']']],
  ['[[]', ['[']],
  ['file[0-9]', ['file5']],
  ['*[5X]', ['file5', 'fileX']],
]

// The rows where a leading ^ is a class member, as CPython reads it.
const CARET_GOLDEN: [string, string[]][] = [
  ['[^abc]', ['a', 'b', '^']],
  ['[^]a]', []],
  ['[!^]', ['a', 'b', 'd', '!', '-', 'z', '[', ']']],
]

describe('fnmatch matches CPython fnmatch.fnmatchcase', () => {
  for (const [pattern, hits] of GOLDEN) {
    it(`pattern ${JSON.stringify(pattern)}`, () => {
      const expected = new Set(hits)
      for (const name of NAMES) expect(fnmatch(name, pattern)).toBe(expected.has(name))
    })
  }
})

describe('fnmatchcase is CPython fnmatch.fnmatchcase exactly', () => {
  const caretRows = new Set(['[^abc]'])
  for (const [pattern, hits] of [
    ...GOLDEN.filter(([pattern]) => !caretRows.has(pattern)),
    ...CARET_GOLDEN,
  ]) {
    it(`pattern ${JSON.stringify(pattern)}`, () => {
      const expected = new Set(hits)
      for (const name of NAMES) expect(fnmatchcase(name, pattern)).toBe(expected.has(name))
    })
  }
})

// A character is a code point, as in a Python str: `?` and a class take a
// whole surrogate pair, and a range compares code points.
describe.each([fnmatch, fnmatchcase])('%o matches code points', (matcher) => {
  it.each([
    ['😀.txt', '?.txt', true],
    ['😀.txt', '[😀😁].txt', true],
    ['\ue000', '[a-😀]', true],
    ['😀', '[!a]', true],
    ['a😀b', 'a??b', false],
  ])('%j against %j is %s', (name, pattern, expected) => {
    expect(matcher(name, pattern)).toBe(expected)
  })
})

describe('fnmatch edge semantics', () => {
  it('* crosses / and newline like Python (no path-awareness)', () => {
    expect(fnmatch('a/b', '*')).toBe(true)
    expect(fnmatch('a\nb', 'a*b')).toBe(true)
  })

  it('invalid range [z-a] never matches and never throws', () => {
    expect(fnmatch('z', '[z-a]')).toBe(false)
    expect(fnmatch('-', '[z-a]')).toBe(false)
  })

  it('lone [ is a literal', () => {
    expect(fnmatch('[ab', '[ab')).toBe(true)
    expect(fnmatch('a', '[ab')).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(fnmatch('A.TXT', '*.txt')).toBe(false)
    expect(fnmatch('a.txt', '*.txt')).toBe(true)
  })

  it('leading ^ negates a class like ! (bash/glibc semantics)', () => {
    expect(fnmatch('c.txt', '[^ab].txt')).toBe(true)
    expect(fnmatch('a.txt', '[^ab].txt')).toBe(false)
    expect(fnmatch('^', '[a^]')).toBe(true)
    expect(fnmatch('b', '[a^]')).toBe(false)
  })

  it('matches a many-star pattern in linear time', () => {
    const name = 'a'.repeat(5000)
    const started = performance.now()
    expect(fnmatch(name, '*a'.repeat(12) + '*b')).toBe(false)
    expect(fnmatch(name, '*a'.repeat(12) + '*')).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('never matches a class with an out-of-order range', () => {
    expect(fnmatch('b', '[z-a]')).toBe(false)
    expect(fnmatch('b', '[!z-a]')).toBe(false)
    expect(fnmatch('-', '[a-]')).toBe(true)
  })
})

const EXTGLOB_NAMES = [
  '',
  'a',
  'b',
  'c',
  'ab',
  'abc',
  'bb',
  'aa',
  'ac',
  'a(b)',
  'a(b|d)',
  'a|b',
  '123',
  '😀',
  'a\nb',
]

const EXTGLOB_GOLDEN: [string, string[]][] = [
  ['@(a|b)', ['a', 'b']],
  ['?(a|b)', ['', 'a', 'b']],
  ['*(a|b)', ['', 'a', 'b', 'ab', 'bb', 'aa']],
  ['+(a|b)', ['a', 'b', 'ab', 'bb', 'aa']],
  [
    '!(a|b)',
    ['', 'c', 'ab', 'abc', 'bb', 'aa', 'ac', 'a(b)', 'a(b|d)', 'a|b', '123', '😀', 'a\nb'],
  ],
  [
    '!(a)*',
    [
      '',
      'a',
      'b',
      'c',
      'ab',
      'abc',
      'bb',
      'aa',
      'ac',
      'a(b)',
      'a(b|d)',
      'a|b',
      '123',
      '😀',
      'a\nb',
    ],
  ],
  ['a!(b)c', ['ac']],
  ['@(a|+(b|c))', ['a', 'b', 'c', 'bb']],
  [
    '*(!(a))',
    ['', 'b', 'c', 'ab', 'abc', 'bb', 'aa', 'ac', 'a(b)', 'a(b|d)', 'a|b', '123', '😀', 'a\nb'],
  ],
  ['+(?(a))', ['', 'a', 'aa']],
  ['@(|a)', ['', 'a']],
  [
    '!()',
    ['a', 'b', 'c', 'ab', 'abc', 'bb', 'aa', 'ac', 'a(b)', 'a(b|d)', 'a|b', '123', '😀', 'a\nb'],
  ],
  ['@(a(b)|c)', ['c', 'a(b)']],
  ['@(a(b|d)|c)', ['c', 'a(b|d)']],
  ['+([[:digit:]])', ['123']],
  ['@(😀|a)', ['a', '😀']],
  ['@([!a]|ab)', ['b', 'c', 'ab', '😀']],
  ['@(a[|]b|c)', ['c', 'a|b']],
]

describe('extended groups match GNU Bash 5.2.37', () => {
  it.each(EXTGLOB_GOLDEN)('pattern %s', (pattern, hits) => {
    for (const name of EXTGLOB_NAMES)
      expect(fnmatch(name, pattern, true), name).toBe(hits.includes(name))
  })
})

it.each([
  ['.h', '@(.h|a)', true],
  ['.h', '?(.h)', true],
  ['.h', '*(.h)', true],
  ['.h', '!(a)', false],
  ['.h', '!(a).h', false],
  ['.h', '*(x).h', true],
  ['.h', '*.h', false],
  ['.h', '@([.]h|a)', false],
  ['.h', '@(.*|a)', true],
] as [string, string, boolean][])('pathname %s %s', (name, pattern, expected) => {
  expect(fnmatch(name, pattern, true, true)).toBe(expected)
})

it('keeps extended groups opt-in and terminates nullable repetition', () => {
  expect(fnmatch('a', '@(a|b)')).toBe(false)
  expect(fnmatch('@(a|b)', '@(a|b)')).toBe(true)
  expect(fnmatch('a'.repeat(80), '+(?(a))', true)).toBe(true)
  expect(fnmatch('a'.repeat(80) + 'b', '+(?(a))', true)).toBe(false)
})

it('a star hands a group every tail', () => {
  expect(fnmatch('', '*!(a)x', true)).toBe(false)
  expect(fnmatch('x', '*!(a)x', true)).toBe(true)
  expect(fnmatch('a', '*!(a)', true)).toBe(true)
  expect(fnmatch('', '*+([!a]|!([!a]))', true)).toBe(true)
})

it.each([
  ['+(*)', '', true],
  ['+(*)b', '', false],
  ['*(*)', '', true],
  ['+(a|*)b', '', false],
  ['*+(*)', '', true],
  ['+(aa)', '', true],
  ['+(aa)', 'a', false],
  ['+(*(aa))', '', true],
  ['+(?(aa))', 'a', false],
  ['*(+(aa)|b)', 'c', false],
  ['+(@(*(aa)|b))', '', true],
  ['*!(a)', '', true],
  ['*!(*)', '', false],
  ['*!(a*)', '', true],
  ['*!(*a)', '', true],
  ['*!(*b)', '', true],
  ['*!(+(aa))', 'a', true],
] as [string, string, boolean][])(
  'long subjects match in linear time: %s',
  (pattern, tail, expected) => {
    expect(fnmatch('a'.repeat(16000) + tail, pattern, true)).toBe(expected)
  },
)

it.each(['@', '?', '+', '*'])('deep %s groups use an explicit stack', (operator) => {
  const pattern = (operator + '(').repeat(1200) + 'a' + ')'.repeat(1200)
  expect(fnmatch('a', pattern, true)).toBe(true)
  expect(fnmatch('b', pattern, true)).toBe(false)
})
