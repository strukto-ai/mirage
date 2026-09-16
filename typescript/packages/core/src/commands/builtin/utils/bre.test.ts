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

import { BreError, compileBre, searchBre, translateBre } from './bre.ts'

// Every row below is a differential result against GNU grep 3.11, GNU nl 9.4
// and GNU expr 9.4 on glibc 2.39 under `LC_ALL=C`: 208 patterns crossed with
// 60 subject lines, zero mismatches in either host. The pattern, a subject the
// unanchored search matches, and one it must not. Mirrors `test_bre.py`.
const SEMANTICS: [string, string, string][] = [
  // The escaping inversion: the escaped spellings are the operators
  // and the bare ones are ordinary characters, which is the exact
  // opposite of what the RegExp engine reads.
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
  ['a}b', 'a}b', 'ab'],
  // Intervals, including the open low bound glibc reads as zero.
  ['a\\{2,\\}', 'aaa', 'a'],
  ['xa\\{,3\\}y', 'xy', 'xz'],
  ['xa\\{,\\}y', 'xy', 'xz'],
  ['a\\{01\\}', 'a', 'b'],
  ['^a\\{1,2\\}b', 'aab', 'aaab'],
  // A quantifier with nothing in front of it is a literal, not a
  // refusal: glibc has no "nothing to repeat" for a BRE at all.
  ['*abc', '*abc', 'abc'],
  ['^*abc', '*abc', 'abc'],
  ['\\(*a\\)', '*a', 'a'],
  ['a\\|*b', '*b', 'x'],
  ['\\+', '+', 'x'],
  ['\\?', '?', 'x'],
  ['\\{1\\}', '{1}', 'x'],
  ['\\{2,1\\}', '{2,1}', 'x'],
  ['\\{x\\}', '{x}', 'x'],
  ['\\{32768\\}', '{32768}', 'x'],
  // The control that proves the model: the first `\{` is a literal
  // `{`, scanning continues, and the second interval quantifies the
  // `}` the first one left behind.
  ['\\{1\\}\\{2\\}', '{1}}', '{1}'],
  // Anchors are context-dependent. `^` anchors at the start of the
  // pattern, just after `\(` and just after `\|`, and is a literal
  // caret everywhere else -- including straight after another `^`.
  ['^ab', 'ab', 'xab'],
  ['a^b', 'a^b', 'ab'],
  ['\\(^ab\\)', 'ab', 'xab'],
  ['x\\|^a', 'abc', '^abc'],
  ['^^a', '^abc', 'abc'],
  ['\\(^^a\\)', '^abc', 'abc'],
  ['\\(\\^a\\)', '^abc', 'abc'],
  ['\\b^a', 'x^abc', 'abc'],
  ['\\(a\\)^b', 'a^b', 'ab'],
  // `$` anchors at the end of the pattern and before `\)` or `\|`.
  ['ab$', 'xab', 'abc'],
  ['a$b', 'a$b', 'ab'],
  ['\\(c$\\)', 'abc', 'abcd'],
  ['c$\\|x', 'abc', 'yz'],
  ['c$$', 'abc$', 'abc'],
  // Bracket expressions: everything inside is ordinary, a `]` in the
  // first slot is a member, and a backslash is just a backslash.
  ['[]]', 'x]y', 'xyz'],
  ['[^]]', 'x', ']'],
  ['[]a.]', ']', 'x'],
  ['[-a]', '-', 'b'],
  ['[a-]', '-', 'b'],
  ['[a-c-]', '-', 'z'],
  ['[a-cd-f]', 'e', 'z'],
  ['[+?]', 'a+b', 'ab'],
  ['[a\\]', '\\', 'b'],
  ['[[.a.]-z]', 'm', '1'],
  ['[a[.b.]-c]', 'c', 'z'],
  ['[a-[.b.]]', 'b', 'z'],
  ['[[.a.]]', 'a', 'b'],
  ['[[=a=]]', 'a', 'b'],
  ['[a-c[:digit:]]', '9', 'zz'],
  ['[[:digit:]a-c]', '9', 'zz'],
  // POSIX classes are expanded to their `LC_ALL=C` sets rather than
  // handed over: handing them over unchanged would make `[[:alpha:]]` a
  // nested-set error in JavaScript.
  ['[[:alpha:]]', 'abc', '123'],
  ['[[:digit:]]', 'a1', 'abc'],
  ['[[:space:]]', 'a b', 'ab'],
  ['[[:punct:]]', 'a-b', 'ab'],
  ['[[:upper:]]', 'aB', 'ab'],
  ['[[:alnum:]_]', '_', '-'],
  // GNU's escapes, expanded for the same reason: the two hosts would otherwise each
  // inherit their own engine's idea of a word character.
  ['\\w\\+', 'abc', '---'],
  ['\\W', '-', 'abc'],
  ['\\s', 'a b', 'ab'],
  ['\\S', 'a', ' '],
  ['\\<a', 'x a', 'xa'],
  ['a\\>', 'a x', 'ax'],
  ['\\`a', 'abc', 'xabc'],
  ["a\\'", 'xa', 'ax'],
  ['\\0', '0', 'x'],
  // Backreferences, and an ordinary escaped literal.
  ['\\(a\\)\\1', 'aa', 'ab'],
  ['\\(a\\)b\\1', 'aba', 'abb'],
  ['a\\.b', 'a.b', 'axb'],
  ['a.b', 'axb', 'ab'],
  ['a\\\\b', 'a\\b', 'ab'],
]

// glibc's `regerror` strings, measured through both `expr abc : PAT` and
// `nl -b pPAT`, which answer identically. `Invalid preceding regular
// expression` is absent on purpose: no BRE reaches it.
const REFUSALS: [string, string][] = [
  ['[', 'Invalid regular expression'],
  ['[^', 'Invalid regular expression'],
  ['[a', 'Unmatched [, [^, [:, [., or [='],
  ['[]', 'Unmatched [, [^, [:, [., or [='],
  ['[[', 'Unmatched [, [^, [:, [., or [='],
  ['[[:alpha:', 'Unmatched [, [^, [:, [., or [='],
  ['[[:alpha:]', 'Unmatched [, [^, [:, [., or [='],
  ['[.', 'Unmatched [, [^, [:, [., or [='],
  ['[=', 'Unmatched [, [^, [:, [., or [='],
  ['[-', 'Unmatched [, [^, [:, [., or [='],
  ['[a-', 'Unmatched [, [^, [:, [., or [='],
  ['\\(', 'Unmatched ( or \\('],
  ['a\\(b', 'Unmatched ( or \\('],
  ['\\)', 'Unmatched ) or \\)'],
  ['a\\)', 'Unmatched ) or \\)'],
  ['\\', 'Trailing backslash'],
  ['\\1', 'Invalid back reference'],
  ['\\9', 'Invalid back reference'],
  ['\\(a\\)\\2', 'Invalid back reference'],
  ['\\(a\\1\\)', 'Invalid back reference'],
  ['[[:bogus:]]', 'Invalid character class name'],
  ['[[.ab.]]', 'Invalid collation character'],
  ['[[..]]', 'Invalid collation character'],
  ['[[=ab=]]', 'Invalid collation character'],
  ['a\\{1,', 'Unmatched \\{'],
  ['a\\{\\}', 'Invalid content of \\{\\}'],
  ['a\\{x\\}', 'Invalid content of \\{\\}'],
  ['a\\{ 1\\}', 'Invalid content of \\{\\}'],
  ['a\\{-1\\}', 'Invalid content of \\{\\}'],
  ['a\\{2,1\\}', 'Invalid content of \\{\\}'],
  ['a\\{1,,2\\}', 'Invalid content of \\{\\}'],
  ['a\\{1,2,3\\}', 'Invalid content of \\{\\}'],
  // A newline inside the body is not a bound either. JavaScript's `$` is
  // the absolute end of the subject without the `m` flag, so these four were
  // already refused here; the python twin had to say `fullmatch` to agree,
  // and GNU refuses them (`expr aa : 'a\{2<newline>\}'` is
  // `expr: Invalid content of \{\}`, exit 2).
  ['a\\{2\n\\}', 'Invalid content of \\{\\}'],
  ['a\\{\n\\}', 'Invalid content of \\{\\}'],
  ['a\\{2,\n\\}', 'Invalid content of \\{\\}'],
  ['a\\{1,2\n\\}', 'Invalid content of \\{\\}'],
  ['a\\{32768\\}', 'Regular expression too big'],
  ['a\\{0,32768\\}', 'Regular expression too big'],
  ['a\\{100000\\}', 'Regular expression too big'],
  // `Invalid range end` is about the KIND of endpoint, not its order:
  // a class or an equivalence class on either side is refused, and so
  // is a `-x` that follows an already-closed range.
  ['[[:alpha:]-z]', 'Invalid range end'],
  ['[z-[:alpha:]]', 'Invalid range end'],
  ['[a-[:alpha:]]', 'Invalid range end'],
  ['[[=a=]-z]', 'Invalid range end'],
  ['[a-[=b=]]', 'Invalid range end'],
  ['[a-c-e]', 'Invalid range end'],
  ['[a-b-c]', 'Invalid range end'],
  ['[z-a-c]', 'Invalid range end'],
]

// A collating element IS a legal range endpoint, and a trailing `-` is a
// member rather than a second range end. The mirror of the four
// `Invalid range end` rows above.
const LEGAL_RANGES = [
  '[[.a.]-z]',
  '[a[.b.]-c]',
  '[a-[.b.]]',
  '[a-c-]',
  '[a-cd-f]',
  '[a-]',
  '[-a]',
  '[--a]',
  '[-a-c]',
  '[a-c[:digit:]]',
  '[[:digit:]a-c]',
]

// The one construct the two GNU dialects read differently. grep and sed
// refuse an inverted plain-character range; expr and nl compile it to an
// empty set, which matches nothing (or, negated, any one character).
const INVERTED_RANGES = ['[z-a]', '[9-0]', '[b-a]', '[a--]', '[^z-a]', '[9-0]x', '[[.z.]-[.a.]]']

// The host source, spelled out where the inversion is the whole point.
const TRANSLATIONS: [string, string, number][] = [
  ['\\(a\\)', '(a)', 1],
  ['(a)', '\\(a\\)', 0],
  ['a\\|b', 'a|b', 0],
  ['a|b', 'a\\|b', 0],
  ['a\\+', 'a+', 0],
  ['a+', 'a\\+', 0],
  ['a\\{2,3\\}', 'a{2,3}', 0],
  ['a{2}', 'a\\{2\\}', 0],
  ['*a', '\\*a', 0],
  ['[[:alpha:]]', '[A-Za-z]', 0],
  ['\\w', '[0-9A-Za-z_]', 0],
  ['\\(^a\\)', '(^a)', 1],
  ['^^a', '^\\^a', 0],
  ['[z-a]', '[^\\s\\S]', 0],
  ['[^z-a]', '[\\s\\S]', 0],
  ['\\(a\\)\\(b\\)', '(a)(b)', 2],
  ['', '', 0],
]

describe('bre semantics', () => {
  it.each(SEMANTICS)('matches GNU basic expression semantics for %s', (pattern, hit, miss) => {
    const compiled = searchBre(pattern)
    expect(compiled.test(hit)).toBe(true)
    compiled.lastIndex = 0
    expect(compiled.test(miss)).toBe(false)
  })
})

describe('bre refusals', () => {
  it.each(REFUSALS)('words %s the way glibc words it', (pattern, message) => {
    expect(() => translateBre(pattern)).toThrow(new BreError(message))
  })

  it('has no "nothing to repeat" refusal at all', () => {
    // glibc never produces `Invalid preceding regular expression` from a BRE:
    // it re-reads the operator as an ordinary character instead.
    for (const pattern of ['*a', '\\+', '\\?', '\\{1\\}', '\\{2,1\\}', '\\{32768\\}']) {
      expect(() => translateBre(pattern)).not.toThrow()
    }
  })

  it('refuses one past glibc RE_DUP_MAX and not at it', () => {
    expect(searchBre('a\\{0,32767\\}').test('a')).toBe(true)
    expect(() => translateBre('a\\{32768\\}')).toThrow(new BreError('Regular expression too big'))
  })
})

describe('bre range endpoints', () => {
  it.each(LEGAL_RANGES)('accepts a collating endpoint or a trailing dash in %s', (pattern) => {
    expect(() => searchBre(pattern)).not.toThrow()
  })

  it.each(INVERTED_RANGES)('reads %s as an empty set for expr and nl', (pattern) => {
    // Both host engines refuse the range outright, so the empty set has to be
    // spelled out rather than left to them.
    expect(() => translateBre(pattern)).not.toThrow()
  })

  it.each(INVERTED_RANGES)("refuses %s in grep's dialect", (pattern) => {
    expect(() => translateBre(pattern, true)).toThrow(new BreError('Invalid range end'))
  })

  it('matches nothing, and matches any one character when negated', () => {
    expect(searchBre('[z-a]').test('z')).toBe(false)
    expect(searchBre('[9-0]x').test('x')).toBe(false)
    expect(searchBre('[^z-a]').test('q')).toBe(true)
    expect(searchBre('[^z-a]').test('')).toBe(false)
  })
})

describe('bre translation', () => {
  it.each(TRANSLATIONS)('inverts the escaping for %s', (pattern, source, groups) => {
    expect(translateBre(pattern)).toEqual([source, groups])
  })

  it('anchors a trailing dollar as the end of input', () => {
    // JavaScript's `$` without the `m` flag already means end of input, which
    // is what GNU's means; python has to spell it `\\Z`.
    expect(translateBre('ab$')).toEqual(['ab$', 0])
    expect(searchBre('b$').test('ab\n')).toBe(false)
  })

  it("expands a word class to the ASCII set rather than the engine's", () => {
    expect(searchBre('\\w').test('\u00e9')).toBe(false)
    expect(searchBre('\\W').test('\u00e9')).toBe(true)
  })

  it('wraps a stacked quantifier rather than refusing it', () => {
    // glibc reads `a**` as `(a*)*`; both host engines refuse a bare second
    // quantifier.
    expect(searchBre('a**').test('aaa')).toBe(true)
    expect(searchBre('a**').test('')).toBe(true)
  })
})

describe('bre entry points', () => {
  it('anchors the one expr uses', () => {
    // `expr abc : 'b'` is 0: `re_match` anchors at position 0.
    expect(compileBre('b')[0].test('abc')).toBe(false)
    expect(compileBre('a')[0].test('abc')).toBe(true)
  })

  it('does not anchor the one nl uses', () => {
    // `printf 'foo\n' | nl -b po` numbers the line: `re_search` does not
    // anchor. The two entry points differ only in that.
    expect(searchBre('o').test('foo')).toBe(true)
    expect(searchBre('^o').test('foo')).toBe(false)
  })

  it('reports a group count that survives a failed match', () => {
    // It is what tells `:` whether to answer with group 1 or with the match
    // length, and a failed match has no match object to ask.
    const [compiled, groups] = compileBre('\\(x\\)')
    expect(groups).toBe(1)
    expect(compiled.test('abc')).toBe(false)
  })
})
