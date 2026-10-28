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
import { piece } from './types.ts'

function words(template: string): string[] | null {
  const out = expandTemplate(template)
  return out === null ? null : [...out]
}

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
    expect(words(template)).toEqual(expected)
  })

  it.each(LITERAL_CASES)('returns null for literal %s', (template) => {
    expect(words(template)).toBeNull()
  })

  it('inert atoms alternate but never form a range', () => {
    const atom = makeInert(0)
    expect(words(`{a,${atom}}`)).toEqual(['a', atom])
    expect(words(`{1..${atom}}`)).toBeNull()
  })

  it('inert prefix and suffix stitch', () => {
    const atom = makeInert(0)
    expect(words(`${atom}{a,b}`)).toEqual([`${atom}a`, `${atom}b`])
    expect(words(`{a,b}${atom}`)).toEqual([`a${atom}`, `b${atom}`])
  })

  it.each([
    ['{1..1000000000000}', ['1', '2', '3']],
    ['{a,b}{1..1000000000000}', ['a1', 'a2', 'a3']],
  ])('makes the words of %s as they are read', (template, expected) => {
    const first: string[] = []
    for (const word of expandTemplate(template) ?? []) {
      first.push(word)
      if (first.length === 3) break
    }
    expect(first).toEqual(expected)
  })
})

describe('substitute', () => {
  it('replaces atoms in order', () => {
    const word = `x${makeInert(0)}y${makeInert(1)}`
    expect(substitute(word, [[piece('A', true)], [piece('B')]])).toEqual([
      piece('x'),
      piece('A', true),
      piece('y'),
      piece('B'),
    ])
  })

  it('is one literal piece without atoms', () => {
    expect(substitute('plain', [[piece('unused')]])).toEqual([piece('plain')])
  })

  it('gives an empty word no pieces', () => {
    expect(substitute('', [])).toEqual([])
  })
})

describe('exact decimal ranges', () => {
  const cases: [string, string[]][] = [
    ['{9007199254740993..9007199254740993..2}', ['9007199254740993']],
    [
      '{9007199254740992..9007199254740994}',
      ['9007199254740992', '9007199254740993', '9007199254740994'],
    ],
    [
      '{9007199254740994..9007199254740992}',
      ['9007199254740994', '9007199254740993', '9007199254740992'],
    ],
    ['{9223372036854775806..9223372036854775807}', ['9223372036854775806', '9223372036854775807']],
    [
      '{-9223372036854775808..-9223372036854775807}',
      ['-9223372036854775808', '-9223372036854775807'],
    ],
    ['{1..9..-9223372036854775807}', ['1']],
    ['{a..z..9223372036854775807}', ['a']],
    ['{3..1..0}', ['3', '2', '1']],
    ['{3..-3..-9223372036854775808}', ['3']],
    ['{3..3..-9223372036854775808}', ['3']],
    ['{-01..-02..-9223372036854775808}', ['-01']],
    ['{z..a..-9223372036854775808}', ['z']],
    ['{a..a..-9223372036854775808}', ['a']],
    ['{0..-9223372036854775808..-9223372036854775808}', ['0', '-9223372036854775808']],
  ]
  it.each(cases)('expands %s exactly', (template, expected) => {
    expect(words(template)).toEqual(expected)
  })
  it.each([
    '{9223372036854775808..9223372036854775808..9223372036854775807}',
    '{-9223372036854775809..-9223372036854775809..9223372036854775807}',
    '{1..9..-9223372036854775808}',
    '{1..9..9223372036854775808}',
    '{a..z..-9223372036854775808}',
    '{a..z..9223372036854775808}',
    '{١..٣}',
    '{a..z..٢}',
    '{1..3\n}',
    '{a..c\n}',
  ])('leaves invalid range %s literal', (template) => {
    expect(words(template)).toBeNull()
  })
})

describe('explicit signed ranges', () => {
  const cases: [string, string[]][] = [
    ['{+1..3}', ['1', '2', '3']],
    ['{1..3..+1}', ['1', '2', '3']],
    ['{+01..+03}', ['1', '2', '3']],
    ['{-01..+1}', ['-01', '000', '001']],
    ['{a..e..+2}', ['a', 'c', 'e']],
    ['{1..5..+02}', ['1', '3', '5']],
  ]
  it.each(cases)('expands %s', (template, expected) => {
    expect(words(template)).toEqual(expected)
  })
  it('leaves oversized decimal ranges literal without converting them', () => {
    expect(words('{' + '9'.repeat(5000) + '..3}')).toBeNull()
  })
  it('preserves many leading zeros', () => {
    const zeros = '0'.repeat(5000)
    expect(words(`{${zeros}1..${zeros}2}`)).toEqual([`${zeros}1`, `${zeros}2`])
  })
})

describe('extreme range admission', () => {
  const cases: [string, string[] | null][] = [
    ['{9223372036854775807..0..9223372036854775807}', null],
    ['{-9223372036854775808..9223372036854775807..9223372036854775807}', null],
    ['{9223372036854775807..1..9223372036854775807}', null],
    ['{9223372036854775807..2..9223372036854775807}', ['9223372036854775807']],
    ['{9223372036854775806..0..9223372036854775807}', null],
    ['{9223372036854775805..0..9223372036854775807}', ['9223372036854775805']],
    ['{-9223372036854775808..-2..9223372036854775807}', null],
    ['{-9223372036854775808..-3..9223372036854775807}', ['-9223372036854775808']],
    ['{-9223372036854775807..-1..9223372036854775807}', null],
    ['{-9223372036854775807..-2..9223372036854775807}', ['-9223372036854775807']],
    ['{0..9223372036854775807..9223372036854775807}', ['0', '9223372036854775807']],
    ['{0..-9223372036854775808..-9223372036854775808}', ['0', '-9223372036854775808']],
    ['{9223372036854775807..0..-9223372036854775808}', null],
    ['{9223372036854775807..9223372036854775807..-9223372036854775808}', ['9223372036854775807']],
    ['{9..1..9223372036854775807}', ['9']],
    ['{-9..-10..9223372036854775807}', ['-9']],
    ['{9223372036854775807..0..-9223372036854775807}', null],
    ['{+9223372036854775807..+0..+9223372036854775807}', null],
    ['{09223372036854775807..00..9223372036854775807}', null],
    [
      'pre{9223372036854775807..0..9223372036854775807}post{a,b}',
      [
        'pre{9223372036854775807..0..9223372036854775807}posta',
        'pre{9223372036854775807..0..9223372036854775807}postb',
      ],
    ],
    [
      '{{9223372036854775807..0..9223372036854775807},ok}',
      ['{9223372036854775807..0..9223372036854775807}', 'ok'],
    ],
    ['{9223372036854775807..1..4611686018427387903}', null],
  ]
  it.each(cases)('matches Bash for %s', (template, expected) => {
    expect(words(template)).toEqual(expected)
  })
})
