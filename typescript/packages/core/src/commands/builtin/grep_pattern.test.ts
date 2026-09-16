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
import { compilePattern, mergePatternList, NEVER_MATCH } from './grep_pattern.ts'

const ENC = new TextEncoder()

describe('compilePattern', () => {
  it('single pattern keeps regex semantics', () => {
    const pat = compilePattern('fo+')
    expect(pat.test('foo')).toBe(true)
    expect(pat.test('f')).toBe(false)
  })

  it('single fixed string escapes regex chars', () => {
    const pat = compilePattern('a.b', false, true)
    expect(pat.test('xa.by')).toBe(true)
    expect(pat.test('axb')).toBe(false)
  })

  it('newline-separated patterns match any', () => {
    const pat = compilePattern('foo\nbar')
    expect(pat.test('a foo b')).toBe(true)
    expect(pat.test('a bar b')).toBe(true)
    expect(pat.test('baz')).toBe(false)
  })

  it('newline-separated regex alternation grouping', () => {
    const pat = compilePattern('ab+\ncd')
    expect(pat.test('abb')).toBe(true)
    expect(pat.test('xcdy')).toBe(true)
    expect(pat.test('ax')).toBe(false)
  })

  it('newline-separated fixed strings escape each', () => {
    const pat = compilePattern('a.b\nc+', false, true)
    expect(pat.test('xa.by')).toBe(true)
    expect(pat.test('c+')).toBe(true)
    expect(pat.test('axb')).toBe(false)
    expect(pat.test('cc')).toBe(false)
  })

  it('newline-separated whole word applies per pattern', () => {
    const pat = compilePattern('foo\nbar', false, false, true)
    expect(pat.test('a foo b')).toBe(true)
    expect(pat.test('bar.')).toBe(true)
    expect(pat.test('foobar')).toBe(false)
  })

  it('newline-separated ignore case', () => {
    const pat = compilePattern('foo\nbar', true)
    expect(pat.test('FOO')).toBe(true)
    expect(pat.test('Bar')).toBe(true)
  })
})

describe('mergePatternList', () => {
  it('file only', () => {
    expect(mergePatternList(null, ENC.encode('foo\nbar\n'))).toBe('foo\nbar')
  })

  it('combines flag and file patterns', () => {
    expect(mergePatternList('x', ENC.encode('y\nz\n'))).toBe('x\ny\nz')
  })

  it('no file keeps the pattern', () => {
    expect(mergePatternList('x', null)).toBe('x')
  })

  it('empty file yields null (GNU: zero patterns)', () => {
    expect(mergePatternList(null, new Uint8Array())).toBeNull()
  })

  it('single blank line is one empty pattern', () => {
    expect(mergePatternList(null, ENC.encode('\n'))).toBe('')
  })
})

describe('NEVER_MATCH', () => {
  it('matches nothing', () => {
    const pat = compilePattern(NEVER_MATCH)
    expect(pat.test('')).toBe(false)
    expect(pat.test('anything')).toBe(false)
  })
})

describe('ASCII semantics for word boundaries and case folding', () => {
  // Every row measured against GNU grep 3.11 under LC_ALL=C, which is the
  // locale mirage renders in: `grep -w ab` on `éab` and `grep -w a` on `aé`
  // both select the line, while `grep -i k` on U+212A and `grep -i s` on
  // U+017F select nothing. A non-`u` RegExp already answers GNU's way; the
  // python twin needs `re.ASCII` to, and this pins the pair together.
  it.each([
    ['ab', 'éab', false, true, true],
    ['a', 'aé', false, true, true],
    ['k', 'K', true, false, false],
    ['s', 'ſ', true, false, false],
    ['ab', 'xab', false, true, false],
    ['k', 'K', true, false, true],
  ])('%j on %j', (pattern, subject, ignoreCase, wholeWord, selected) => {
    const pat = compilePattern(pattern, ignoreCase, false, wholeWord, true)
    expect(pat.test(subject)).toBe(selected)
  })

  it('keeps the word class ASCII in an extended expression', () => {
    // -E takes the same compile, so `\w` must not grow a Unicode meaning
    // there either.
    const pat = compilePattern('\\w', false, false, false, false)
    expect(pat.test('é')).toBe(false)
    expect(pat.test('a')).toBe(true)
  })
})
