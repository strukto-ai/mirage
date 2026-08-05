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

import { breToRegExp } from './bre.js'

// Every row is a differential result against GNU grep 3.x on Debian: the
// pattern, a subject it matches, and a subject it must not. The untranslated
// pattern passed all of these to the RegExp engine and got the opposite answer
// on most of them, which is why the bug survived.
const CASES: [string, string, string][] = [
  ['a+b', 'a+b', 'aab'],
  ['a\\+b', 'aab', 'a+b'],
  ['a?b', 'a?b', 'ab'],
  ['a\\?b', 'ab', 'xyz'],
  ['a|b', 'a|b', 'ab'],
  ['a\\|b', 'ab', 'xyz'],
  ['(ab)', '(ab)', 'ab'],
  ['\\(ab\\)', 'ab', 'ba'],
  ['a{2}', 'a{2}', 'aa'],
  ['a\\{2\\}', 'aa', 'aba'],
  ['*abc', '*abc', 'abc'],
  ['^*abc', '*abc', 'abc'],
  ['a^b', 'a^b', 'ab'],
  ['a$b', 'a$b', 'ab'],
  ['a\\.b', 'a.b', 'axb'],
  ['a.b', 'axb', 'ab'],
  ['[+?]', 'a+b', 'ab'],
  ['\\(a\\)\\1', 'aa', 'ab'],
  ['\\(^ab\\)', 'ab', 'xab'],
  ['a\\{1,\\}', 'a', 'b'],
]

describe('breToRegExp', () => {
  it.each(CASES)('matches GNU basic expression semantics for %s', (pattern, hit, miss) => {
    const compiled = new RegExp(breToRegExp(pattern))
    expect(compiled.test(hit)).toBe(true)
    expect(compiled.test(miss)).toBe(false)
  })

  it('copies a bracket expression out whole', () => {
    // Everything inside brackets is already ordinary in both dialects, so
    // translating inside one would escape characters that are fine.
    expect(breToRegExp('[a+?]')).toBe('[a+?]')
  })

  it('lets a bracket expression hold a literal close', () => {
    expect(breToRegExp('[]]')).toBe('[]]')
  })

  it('lets a negated bracket hold a literal close', () => {
    expect(breToRegExp('[^]]')).toBe('[^]]')
  })

  it('does not end a bracket early on a named class', () => {
    expect(breToRegExp('[[:alpha:]+]')).toBe('[[:alpha:]+]')
  })

  it('anchors a trailing dollar', () => {
    expect(breToRegExp('ab$')).toBe('ab$')
  })

  it('anchors a leading caret', () => {
    expect(breToRegExp('^ab')).toBe('^ab')
  })

  it('keeps an escaped backslash escaped', () => {
    expect(new RegExp(breToRegExp('a\\\\b')).test('a\\b')).toBe(true)
  })

  it('translates an empty pattern to nothing', () => {
    expect(breToRegExp('')).toBe('')
  })
})
