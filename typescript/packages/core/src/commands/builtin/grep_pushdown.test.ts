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
import { PathSpec } from '../../types.ts'
import { PatternType } from './constants.ts'
import {
  classifyPattern,
  isLiteralPattern,
  loneOperand,
  searchTerms,
  wholeWordLiterals,
} from './grep_pushdown.ts'
import { compilePosixRegex } from '../../utils/posix.ts'
import { stripSlash } from '../../utils/slash.ts'

describe('classifyPattern', () => {
  it('newlines and regex are REGEX, plain text is SIMPLE, fixed is EXACT', () => {
    expect(classifyPattern('foo\nbar', false)).toBe(PatternType.REGEX)
    expect(classifyPattern('foo\nbar', true)).toBe(PatternType.REGEX)
    expect(classifyPattern('foo bar', false)).toBe(PatternType.SIMPLE)
    expect(classifyPattern('foo', true)).toBe(PatternType.EXACT)
    expect(classifyPattern('fo+', false)).toBe(PatternType.REGEX)
  })
})

describe('isLiteralPattern', () => {
  it.each([
    ['abc', false, true],
    ['a-b_c.d', false, false],
    ['plain text', false, true],
    ['a.b', false, false],
    ['a*b', false, false],
    ['^start', false, false],
    ['a.b', true, true],
    ['a\nb', false, false],
    ['a\nb', true, true],
  ])('isLiteralPattern(%j, %j) === %j', (pattern, fixed, expected) => {
    expect(isLiteralPattern(pattern, fixed)).toBe(expected)
  })
})

function operand(virtual: string, pattern: string | null = null): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    vfsPath: stripSlash(virtual),
    pattern,
    resolved: pattern === null,
  })
}

const TRACES = operand('/traces')
const SESSIONS = operand('/sessions')

describe('loneOperand', () => {
  it('is the operand rule on its own, for a caller with no pattern', () => {
    // email's find push-down answers for one concrete operand only.
    expect(loneOperand([TRACES])).toBe(TRACES)
    expect(loneOperand([TRACES, SESSIONS])).toBe(null)
    expect(loneOperand([])).toBe(null)
    expect(loneOperand([operand('/traces/*', '*')])).toBe(null)
  })

  it('never answers for stdin', () => {
    // A `-` is the line's stdin, which no backend holds, so every push-down
    // defers to the scan that reads the pipe.
    const dash = new PathSpec({
      virtual: '/traces/-',
      directory: '/traces/',
      vfsPath: 'traces/-',
      resolved: true,
      rawPath: '-',
    })
    expect(loneOperand([dash])).toBe(null)
  })
})

// Twin of test_whole_word_literals_union_only_complete_alternatives.
describe('wholeWordLiterals', () => {
  it.each<[string | null, boolean, boolean, boolean, string[] | null]>([
    ['import', false, true, false, ['import']],
    ['import', false, false, true, ['import']],
    ['import', false, false, false, null],
    ['ada\nbob', false, true, false, ['ada', 'bob']],
    ['ada\nada', true, true, false, ['ada']],
    ['ada\n', false, true, false, null],
    ['ada\nb.b', false, true, false, null],
    ['ada\nb.b', true, true, false, ['ada', 'b.b']],
    [null, false, true, false, null],
  ])('answers %j (fixed=%s, -w=%s, -x=%s) with %j', (pattern, fixed, w, x, expected) => {
    // A pattern list narrows by one search per alternative, so every
    // alternative must be a whole-word literal; an empty one matches every
    // line, and -x is a whole-line, hence whole-word, match.
    expect(wholeWordLiterals(pattern, fixed, w, x)).toEqual(expected)
  })
})

// Twin of test_search_terms_ask_words_or_the_text_every_match_holds.
describe('searchTerms', () => {
  it.each<[string, string, boolean, boolean, [string[], boolean] | null]>([
    ['ada\nbob', '', true, false, [['ada', 'bob'], true]],
    ['conn.*refused', '', false, false, [['refused'], false]],
    ['Conn.*TOMORROW', 'iu', false, true, [['tomorrow'], false]],
    ['Conn.*REFUSED', 'iu', false, true, null],
    ['a.b', '', false, false, null],
    ['café', 'iu', true, true, null],
    ['ada', 'iu', true, true, [['ada'], true]],
    ['sun', 'iu', true, true, null],
    ['sun', 'i', true, true, [['sun'], true]],
  ])('asks %j (flags %j)', (pattern, flags, w, i, expected) => {
    // Whole-word literals go as words; any other pattern as the needles every
    // match holds, never shorter than three characters. Under -i a needle or
    // word with s or k is dropped when case folds by Unicode (the long s
    // folds to s), and a mount's folding of a non-ASCII literal is not
    // trusted.
    const matcher = new RegExp(pattern.replaceAll('\n', '|'), flags)
    expect(searchTerms(pattern, matcher, false, w, false, i)).toEqual(expected)
  })
  it("asks grep's ASCII-folding words under a UTF-8 locale", () => {
    expect(
      searchTerms('sun', compilePosixRegex('sun', 'i', true), false, true, false, true),
    ).toEqual([['sun'], true])
  })
})
