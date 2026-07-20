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
import { FileStat, FileType } from '../../types.ts'
import { PatternType } from './constants.ts'
import {
  classifyPattern,
  compilePattern,
  extractRequiredLiteral,
  grepFilesOnly,
  isRegexPattern,
  mergePatternList,
  NEVER_MATCH,
  searchQuery,
} from './grep_helper.ts'

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

describe('isRegexPattern', () => {
  it('treats a newline-joined pattern list as non-literal', () => {
    expect(isRegexPattern('foo\nbar', false)).toBe(true)
    expect(isRegexPattern('foo\nbar', true)).toBe(true)
  })

  it('keeps plain literals non-regex', () => {
    expect(isRegexPattern('foo bar', false)).toBe(false)
  })
})

describe('classifyPattern', () => {
  it('newlines and regex are REGEX, plain text is SIMPLE, fixed is EXACT', () => {
    expect(classifyPattern('foo\nbar', false)).toBe(PatternType.REGEX)
    expect(classifyPattern('foo\nbar', true)).toBe(PatternType.REGEX)
    expect(classifyPattern('foo bar', false)).toBe(PatternType.SIMPLE)
    expect(classifyPattern('foo', true)).toBe(PatternType.EXACT)
    expect(classifyPattern('fo+', false)).toBe(PatternType.REGEX)
  })
})

describe('extractRequiredLiteral', () => {
  it.each([
    ['import.*os', 'import'],
    ['imp.*rt', 'imp'],
    ['^import', 'import'],
    ['colou?r', 'colo'],
    ['[Ee]rror', 'rror'],
    ['\\d+error', 'error'],
    ['config$', 'config'],
    ['a*b', null],
    ['ab', null],
    ['foo|bar', null],
    ['(ab)?cdef', 'cdef'],
  ])('extracts the longest required literal from %s', (pattern, expected) => {
    expect(extractRequiredLiteral(pattern)).toBe(expected)
  })

  it('the extracted literal is present in every matching sample', () => {
    for (const pattern of ['import.*os', 'colou?r', '[Ee]rror', '\\d+error']) {
      const literal = extractRequiredLiteral(pattern)
      expect(literal).not.toBeNull()
      const re = new RegExp(pattern)
      for (const sample of [
        'import sys, os',
        'color',
        'colour',
        'Error here',
        'an error',
        'x42error',
      ]) {
        if (re.test(sample)) expect(sample).toContain(String(literal))
      }
    }
  })
})

describe('searchQuery', () => {
  it('returns the pattern itself when literal', () => {
    expect(searchQuery('import', false)).toBe('import')
    expect(searchQuery('foo', true)).toBe('foo')
  })
  it('extracts a required literal from a regex', () => {
    expect(searchQuery('import.*os', false)).toBe('import')
  })
  it('returns null when no literal can be proven', () => {
    expect(searchQuery('foo|bar', false)).toBeNull()
  })
})

describe('grepFilesOnly', () => {
  it('scans file operands under recursive instead of walking them', async () => {
    // GNU: `grep -rl pat file` treats the operand as a file; only directory
    // operands are walked (search-narrowed candidates arrive as files).
    const readdirFn = (path: string): Promise<string[]> => Promise.reject(new Error(path))
    const statFn = (path: string): Promise<FileStat> =>
      Promise.resolve(new FileStat({ name: path, type: FileType.TEXT }))
    const readBytesFn = (): Promise<Uint8Array> => Promise.resolve(ENC.encode('alpha beta\n'))
    const hits = await grepFilesOnly(readdirFn, statFn, readBytesFn, '/data/notes.txt', 'alpha', {
      recursive: true,
      ignoreCase: false,
      invert: false,
      lineNumbers: false,
      countOnly: false,
      fixedString: false,
      onlyMatching: false,
      maxCount: null,
      wholeWord: false,
    })
    expect(hits).toEqual(['/data/notes.txt'])
  })
})
