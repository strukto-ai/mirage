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
import { RustRegexError, translateRust, wholeLine, wholeWord } from './rust_regex.ts'

const PCRE2_HINT = 'Use --pcre2 (-P) for look-around and backreferences.'

function findAll(patterns: string[], text: string, ignoreCase = false): string[] {
  const translated = translateRust(patterns, ignoreCase)
  const re = new RegExp(translated.source, translated.ignoreCase ? 'giu' : 'gu')
  return Array.from(text.matchAll(re), (m) => m[0])
}

function rendered(message: string, display: string, carets: string, hint: boolean): string {
  const text = `regex parse error:\n    ${display}\n    ${carets}\nerror: ${message}`
  return hint ? text + '\n\n' + PCRE2_HINT : text
}

// Every row measured with ripgrep 14.1.1 (`printf TEXT | rg -o PATTERN`);
// the rows are `rust_regex.py`'s own.
describe('translateRust', () => {
  it.each([
    ['\\<w[a-z]*', 'word sword', ['word']],
    ['[a-z]*d\\>', 'word sword', ['word', 'sword']],
    ['\\b{start}w[a-z]*', 'word sword', ['word']],
    ['[a-z]*d\\b{end}', 'word sword', ['word', 'sword']],
    ['\\b{start-half}w[a-z]*', 'word sword', ['word']],
    ['\\w+', 'a\u00e9\u0661', ['a\u00e9\u0661']],
    ['\\d+', 'a\u06635', ['\u06635']],
    ['\\s', 'a\u00a0b', ['\u00a0']],
    ['\\bb', '\u00e9 b', ['b']],
    ['\\bb', '\u00e9b', []],
    ['[[:alpha:]]+', 'a\u00e91', ['a']],
    ['(?-u:\\w)+', 'a\u00e9', ['a']],
    ['\\x41', 'A', ['A']],
    ['\\u{41}', 'A', ['A']],
    ['\\U00000041', 'A', ['A']],
    ['(?i)a', 'Aa', ['A', 'a']],
    ['(?i:a)A', 'Aa', []],
    ['a(?i)a', 'aA', ['aA']],
    ['\\Aab\\z', 'ab', ['ab']],
    ['[a-z&&[^b]]', 'ab', ['a']],
    ['[a-c--b]', 'abc', ['a', 'c']],
    ['[a-c~~b-d]', 'abc', ['a']],
    ['[]]', 'a]b', [']']],
    ['[[:^alpha:]c]', 'abc', ['c']],
    ['\\pL+', 'a\u00e91', ['a\u00e9']],
    ['\\PL', 'a\u00e91', ['1']],
    ['\\p{Lu}', '\u00c9\u00e91', ['\u00c9']],
    ['\\p{gc=Nd}', 'a1', ['1']],
    ['\\p{decimal number}', 'a1', ['1']],
    ['a+?', 'aaa', ['a', 'a', 'a']],
    ['a{2}?', 'aaa', ['aa']],
    ['(?U)a+', 'aaa', ['a', 'a', 'a']],
    ['(?x) a b ', 'ab', ['ab']],
    ['(?x)a\\ b', 'a b', ['a b']],
    ['\\-', 'a-b', ['-']],
    ['\\~', 'a~b', ['~']],
    ['x{2}{3}', 'xxxxxx', ['xxxxxx']],
    ['a++', 'ab', ['a']],
    ['(?P<x>a)', 'aa', ['a', 'a']],
    ['(?<x>a)a', 'aa', ['aa']],
    ['(?P<a.b>a)', 'ab', ['a']],
    ['\\a', 'a\u0007b', ['\u0007']],
    ['[&&a]', 'ab', []],
    ['[-a]', 'a-', ['a', '-']],
    ['(?i)[^a]', 'Ab', ['b']],
    ['(?i:[B])', 'ab', ['b']],
    ['^*a', '*a', ['a']],
    ['\\b+a', 'ab', ['a']],
  ] as [string, string, string[]][])('%j over %j', (pattern, text, found) => {
    expect(findAll([pattern], text)).toEqual(found)
  })

  it.each([
    ['\u00e9', '\u00c9\u00e9', ['\u00c9', '\u00e9']],
    ['k', 'K\u212a', ['K', '\u212a']],
    ['s', '\u017f', ['\u017f']],
    ['ss', 'Stra\u00dfe', []],
  ] as [string, string, string[]][])('folds %j over %j', (pattern, text, found) => {
    expect(findAll([pattern], text, true)).toEqual(found)
  })

  it('spells scoped case folding out', () => {
    const translated = translateRust(['a(?-i)b'], true)
    expect(translated.ignoreCase).toBe(false)
    expect(new RegExp(translated.source, 'u').test('Ab')).toBe(true)
    expect(new RegExp(translated.source, 'u').test('AB')).toBe(false)
  })

  it.each([
    [
      ['(?<=id=)\\d+'],
      'look-around, including look-ahead and look-behind, is not supported',
      '(?:(?<=id=)\\d+)',
      '   ^^^^',
      true,
    ],
    [
      ['id=(?=4)'],
      'look-around, including look-ahead and look-behind, is not supported',
      '(?:id=(?=4))',
      '      ^^^',
      true,
    ],
    [
      ['x|(?<!a)|y'],
      'look-around, including look-ahead and look-behind, is not supported',
      '(?:x|(?<!a)|y)',
      '     ^^^^',
      true,
    ],
    [
      ['a', '(?=a)'],
      'look-around, including look-ahead and look-behind, is not supported',
      '(?:a)|(?:(?=a))',
      '         ^^^',
      true,
    ],
    [['(a)\\1'], 'backreferences are not supported', '(?:(a)\\1)', '      ^^', true],
    [['[\\1]'], 'backreferences are not supported', '(?:[\\1])', '    ^^', true],
    [['\\0'], 'backreferences are not supported', '(?:\\0)', '   ^^', true],
    [['('], 'unclosed group', '(?:()', '^', false],
    [['a)'], 'unopened group', '(?:a))', '     ^', false],
    [['[a'], 'unclosed character class', '(?:[a)', '   ^', false],
    [['[^'], 'unclosed character class', '(?:[^)', '   ^^', false],
    [['[]'], 'unclosed character class', '(?:[])', '   ^^', false],
    [['[[]'], 'unclosed character class', '(?:[[])', '    ^^', false],
    [['a\\'], 'unclosed group', '(?:a\\)', '^', false],
    [['*a'], 'repetition operator missing expression', '(?:*a)', '   ^', false],
    [['a|*b'], 'repetition operator missing expression', '(?:a|*b)', '     ^', false],
    [['(?)a'], 'repetition operator missing expression', '(?:(?)a)', '    ^', false],
    [['{1}'], 'repetition operator missing expression', '(?:{1})', '   ^', false],
    [
      ['a{2,1}'],
      'invalid repetition count range, the start must be <= the end',
      '(?:a{2,1})',
      '    ^^^^^',
      false,
    ],
    [['a{,2}'], 'repetition quantifier expects a valid decimal', '(?:a{,2})', '     ^', false],
    [['a{'], 'repetition quantifier expects a valid decimal', '(?:a{)', '     ^', false],
    [['a{1'], 'unclosed counted repetition', '(?:a{1)', '    ^^', false],
    [
      ['a{99999999999}'],
      'decimal literal invalid',
      '(?:a{99999999999})',
      '     ^^^^^^^^^^^',
      false,
    ],
    [['\\d\\Z'], 'unrecognized escape sequence', '(?:\\d\\Z)', '     ^^', false],
    [['\\e'], 'unrecognized escape sequence', '(?:\\e)', '   ^^', false],
    [['\\Qa\\E'], 'unrecognized escape sequence', '(?:\\Qa\\E)', '   ^^', false],
    [['(?z)a'], 'unrecognized flag', '(?:(?z)a)', '     ^', false],
    [['a(?#c)b'], 'unrecognized flag', '(?:a(?#c)b)', '      ^', false],
    [['(?P=x)'], 'unrecognized flag', '(?:(?P=x))', '     ^', false],
    [['(?i-)a'], 'dangling flag negation operator', '(?:(?i-)a)', '      ^', false],
    [['(?ii)a'], 'duplicate flag', '(?:(?ii)a)', '     ^^', false],
    [['(?P<>a)'], 'empty capture group name', '(?:(?P<>a))', '       ^', false],
    [['(?P<a'], 'invalid capture group character', '(?:(?P<a)', '        ^', false],
    [['(?P<1x>a)'], 'invalid capture group character', '(?:(?P<1x>a))', '       ^', false],
    [
      ['(?P<x>a)(?P<x>b)'],
      'duplicate capture group name',
      '(?:(?P<x>a)(?P<x>b))',
      '       ^       ^',
      false,
    ],
    [['[\\b]'], 'invalid escape sequence found in character class', '(?:[\\b])', '    ^^', false],
    [['[\\d-z]'], 'invalid range boundary, must be a literal', '(?:[\\d-z])', '    ^^', false],
    [['[a-\\d]'], 'invalid range boundary, must be a literal', '(?:[a-\\d])', '      ^^', false],
    [
      ['[z-a]'],
      'invalid character class range, the start must be <= the end',
      '(?:[z-a])',
      '    ^^^',
      false,
    ],
    [['\\x4'], 'invalid hexadecimal digit', '(?:\\x4)', '      ^', false],
    [['\\x{}'], 'hexadecimal literal empty', '(?:\\x{})', '     ^^', false],
    [
      ['\\x{110000}'],
      'hexadecimal literal is not a Unicode scalar value',
      '(?:\\x{110000})',
      '      ^^^^^^',
      false,
    ],
    [
      ['\\p{L'],
      'incomplete escape sequence, reached end of pattern prematurely',
      '(?:\\p{L)',
      '        ^',
      false,
    ],
    [['(?x)a # c'], 'unclosed group', '(?:(?x)a # c)', '^', false],
  ] as [string[], string, string, string, boolean][])(
    'refuses %j',
    (patterns, message, display, carets, hint) => {
      let caught: unknown = null
      try {
        translateRust(patterns)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(RustRegexError)
      expect((caught as RustRegexError).message).toBe(rendered(message, display, carets, hint))
    },
  )

  it('refuses an unknown property loudly', () => {
    expect(() => translateRust(['\\p{Greek}'])).toThrow(/not supported in mirage/)
  })

  it('bounds words and lines', () => {
    expect(new RegExp(wholeWord(translateRust(['a-']).source), 'u').test('a-b')).toBe(false)
    expect(new RegExp(wholeWord(translateRust(['a']).source), 'u').test('a b')).toBe(true)
    const line = new RegExp(wholeLine(translateRust(['a|ab']).source, false), 'u')
    expect(line.test('ab')).toBe(true)
    expect(line.test('abc')).toBe(false)
  })
})
