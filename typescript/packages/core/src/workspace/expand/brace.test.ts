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
import { expandTemplate, makeInert, substitute } from './brace.ts'

const EXPAND_CASES: [string, string[]][] = [
  ['{a,b,c}', ['a', 'b', 'c']],
  ['x{a,b}y', ['xay', 'xby']],
  ['{a,b}.txt', ['a.txt', 'b.txt']],
  ['a{,b}c', ['ac', 'abc']],
  ['a{,}b', ['ab', 'ab']],
  ['{,x}', ['', 'x']],
  ['{a,b}{1,2}', ['a1', 'a2', 'b1', 'b2']],
  ['pre{a,b}', ['prea', 'preb']],
  ['{1..5}', ['1', '2', '3', '4', '5']],
  ['{5..1}', ['5', '4', '3', '2', '1']],
  ['{-2..2}', ['-2', '-1', '0', '1', '2']],
  ['{1..9..2}', ['1', '3', '5', '7', '9']],
  ['{9..1..2}', ['9', '7', '5', '3', '1']],
  ['{1..9..-2}', ['1', '3', '5', '7', '9']],
  ['{01..10}', ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']],
  ['{001..5}', ['001', '002', '003', '004', '005']],
  ['{01..10..3}', ['01', '04', '07', '10']],
  ['{-05..5..5}', ['-05', '000', '005']],
  ['{3..3}', ['3']],
  ['{a..e}', ['a', 'b', 'c', 'd', 'e']],
  ['{e..a}', ['e', 'd', 'c', 'b', 'a']],
  ['{a..i..2}', ['a', 'c', 'e', 'g', 'i']],
  ['{A..D}', ['A', 'B', 'C', 'D']],
  ['{Y..b}', ['Y', 'Z', '[', '\\', ']', '^', '_', '`', 'a', 'b']],
  ['{c..c}', ['c']],
  ['{a,{b,c}}', ['a', 'b', 'c']],
  ['x{a,{1,2}b}y', ['xay', 'x1by', 'x2by']],
  ['{a,{1..3}}', ['a', '1', '2', '3']],
  ['{{a,b},{c,{d,e}}}', ['a', 'b', 'c', 'd', 'e']],
  ['{a,{,}}', ['a', '', '']],
  ['{ab{1,2}}', ['{ab1}', '{ab2}']],
  ['a{b{1,2}c', ['a{b1c', 'a{b2c']],
  ['{abc}{1,2}', ['{abc}1', '{abc}2']],
]

const LITERAL_CASES = [
  '{a}',
  '{}',
  '{a,b',
  'a,b}',
  '{a..}',
  '{1..b}',
  '{1..5..x}',
  '{abc}',
  '{aa..bb}',
  '{a\\,b}',
  '{1...3}',
  'plain',
]

describe('expandTemplate', () => {
  it.each(EXPAND_CASES)('expands %s', (template, expected) => {
    expect(expandTemplate(template)).toEqual(expected)
  })

  it.each(LITERAL_CASES)('returns null for literal %s', (template) => {
    expect(expandTemplate(template)).toBeNull()
  })

  it('inert atoms alternate but never form a range', () => {
    const atom = makeInert(0)
    expect(expandTemplate(`{a,${atom}}`)).toEqual(['a', atom])
    expect(expandTemplate(`{1..${atom}}`)).toBeNull()
  })

  it('inert prefix and suffix stitch', () => {
    const atom = makeInert(0)
    expect(expandTemplate(`${atom}{a,b}`)).toEqual([`${atom}a`, `${atom}b`])
    expect(expandTemplate(`{a,b}${atom}`)).toEqual([`a${atom}`, `b${atom}`])
  })
})

describe('substitute', () => {
  it('replaces atoms in order', () => {
    const word = `x${makeInert(0)}y${makeInert(1)}`
    expect(substitute(word, ['A', 'B'])).toBe('xAyB')
  })

  it('is identity without atoms', () => {
    expect(substitute('plain', ['unused'])).toBe('plain')
  })
})
