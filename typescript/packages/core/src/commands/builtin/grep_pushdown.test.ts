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
  textSearchResults,
  classifyPattern,
  extractRequiredLiteral,
  hasSearchShapingFlags,
  isLiteralPattern,
  literalPushdownOperand,
  loneOperand,
  pushdownOperand,
  searchPushdownOk,
  searchQuery,
} from './grep_pushdown.ts'

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
    ['(foo)?bar', 'bar'],
    ['x(foo)*y', null],
    ['foo(bar)?baz', 'foo'],
    ['(foo){0,2}bar', 'bar'],
    ['(foo){1,2}bar', 'foo'],
    ['(foo)+bar', 'foo'],
    ['a(b(cdef)?g)?h', null],
    ['(?:foo)?bar', null],
  ])('extracts the longest required literal from %s', (pattern, expected) => {
    expect(extractRequiredLiteral(pattern)).toBe(expected)
  })

  it('the extracted literal is present in every matching sample', () => {
    for (const pattern of [
      'import.*os',
      'colou?r',
      '[Ee]rror',
      '\\d+error',
      '(foo)?bar',
      'foo(bar)?baz',
    ]) {
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
        'bar',
        'foobar',
        'foobaz',
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
  it('reads a dot as the regex it is', () => {
    // `worker.3` matches `worker-3`, which a substring search for
    // `worker.3` never returns; only the run before the dot is required.
    expect(searchQuery('worker.3', false)).toBe('worker')
    expect(searchQuery('worker.3', true)).toBe('worker.3')
  })
  it('reads a basic expression in its own dialect', () => {
    // grep reads a basic expression unless -E says otherwise, where the
    // operators are the escaped spellings and bare parens are literal.
    expect(searchQuery('fo\\(bar\\)\\?baz', false, true)).toBe('baz')
    expect(searchQuery('(foo)?bar', false, true)).toBe('foo')
    expect(searchQuery('(foo)?bar', false)).toBe('bar')
  })
  it('never answers for a pattern list', () => {
    // A newline-joined -e list is a set of alternatives; no one literal
    // is required by all of them.
    expect(searchQuery('foo\nbar', true)).toBeNull()
    expect(searchQuery('foo\nbar', false)).toBeNull()
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

describe('hasSearchShapingFlags', () => {
  it.each([
    [{}, false],
    [{ i: true }, false],
    [{ F: true }, false],
    [{ r: true }, false],
    [{ v: true }, true],
    [{ n: true }, true],
    [{ c: true }, true],
    [{ args_l: true }, true],
    // A bare `l` key is one the parser never emits: -l is short-only, so
    // it lands on the disambiguated `args_l` dest (`AMBIGUOUS_NAMES`).
    [{ l: true }, false],
    [{ w: true }, true],
    [{ o: true }, true],
    [{ q: true }, true],
    [{ H: true }, true],
    [{ h: true }, true],
    [{ m: '3' }, true],
    [{ A: '2' }, true],
    [{ B: '2' }, true],
    [{ C: '2' }, true],
  ])('hasSearchShapingFlags(%j) === %j', (flags, expected) => {
    expect(
      hasSearchShapingFlags(flags as Record<string, string | boolean | number | string[]>),
    ).toBe(expected)
  })
})

describe('searchPushdownOk', () => {
  it('allows a plain literal, with or without -i', () => {
    expect(searchPushdownOk({}, 'ada')).toBe(true)
    expect(searchPushdownOk({ i: true }, 'ada')).toBe(true)
  })

  it('rejects any shaping flag', () => {
    expect(searchPushdownOk({ v: true }, 'ada')).toBe(false)
    expect(searchPushdownOk({ c: true }, 'ada')).toBe(false)
  })

  it('rejects a regex pattern but allows it under -F', () => {
    expect(searchPushdownOk({}, 'a.b')).toBe(false)
    expect(searchPushdownOk({ F: true }, 'a.b')).toBe(true)
  })
})

function operand(virtual: string, pattern: string | null = null): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/')) || '/',
    resourcePath: virtual.replace(/^\/+|\/+$/g, ''),
    pattern,
    resolved: pattern === null,
  })
}

const EMAIL_HONORED = ['n', 'args_l', 'w', 'o', 'm']

const TRACES = operand('/traces')
const SESSIONS = operand('/sessions')

describe('pushdownOperand', () => {
  it('admits one concrete operand', () => {
    expect(pushdownOperand([TRACES], {}, 'ada')).toBe(TRACES)
  })

  it('refuses a second operand', () => {
    // The bug this gate exists for: the push-down answered for the first
    // operand and dropped the rest in silence.
    expect(pushdownOperand([TRACES, SESSIONS], {}, 'ada')).toBe(null)
    // Two operands in one family, which a per-operand push-down would have
    // answered twice over.
    expect(pushdownOperand([TRACES, TRACES], {}, 'ada')).toBe(null)
  })

  it('refuses no operand', () => {
    expect(pushdownOperand([], {}, 'ada')).toBe(null)
  })

  it('refuses a glob, a shaping flag and a pattern list', () => {
    expect(pushdownOperand([operand('/traces/*', '*')], {}, 'ada')).toBe(null)
    expect(pushdownOperand([TRACES], { c: true }, 'ada')).toBe(null)
    expect(pushdownOperand([TRACES], {}, 'ada\nbob')).toBe(null)
    expect(pushdownOperand([TRACES], {}, null)).toBe(null)
  })
})

describe('hasSearchShapingFlags honored', () => {
  it('exempts only the named dests', () => {
    // gmail/slack/discord: the provider's search is word-based, so -w is what
    // makes the push-down faithful rather than what breaks it.
    expect(hasSearchShapingFlags({ w: true }, ['w'])).toBe(false)
    expect(hasSearchShapingFlags({ w: true, n: true }, ['w'])).toBe(true)
    // email: the local re-scan implements these, so they ride along.
    expect(hasSearchShapingFlags({ n: true, o: true, m: '3' }, EMAIL_HONORED)).toBe(false)
    // ...but never -v or -c, which need messages the search did not return.
    expect(hasSearchShapingFlags({ v: true }, EMAIL_HONORED)).toBe(true)
    expect(hasSearchShapingFlags({ c: true }, EMAIL_HONORED)).toBe(true)
  })

  it('never exempts the operand rule', () => {
    // An exemption is about flags only: two operands still defer.
    expect(pushdownOperand([TRACES, SESSIONS], { w: true }, 'ada', ['w'])).toBe(null)
    expect(pushdownOperand([TRACES], { w: true }, 'ada', ['w'])).toBe(TRACES)
  })
})

describe('loneOperand', () => {
  it('is the operand rule on its own, for a caller with no pattern', () => {
    // email's find push-down has no grep pattern and no shaping flags.
    expect(loneOperand([TRACES])).toBe(TRACES)
    expect(loneOperand([TRACES, SESSIONS])).toBe(null)
    expect(loneOperand([])).toBe(null)
    expect(loneOperand([operand('/traces/*', '*')])).toBe(null)
  })
})

describe('literalPushdownOperand', () => {
  it('adds the LIKE pattern rule to the same operand rule', () => {
    expect(literalPushdownOperand([TRACES], {}, 'ada')).toBe(TRACES)
    // Everything pushdownOperand refuses, this refuses too.
    expect(literalPushdownOperand([TRACES, SESSIONS], {}, 'ada')).toBe(null)
    expect(literalPushdownOperand([TRACES], { c: true }, 'ada')).toBe(null)
    // Plus the one it adds: LIKE matches a regex literally.
    expect(literalPushdownOperand([TRACES], {}, 'a.b')).toBe(null)
    expect(literalPushdownOperand([TRACES], { F: true }, 'a.b')).toBe(TRACES)
  })
})

it.each(['binary', 'text', 'without-match', 'bad'])('binary mode %s requires scanning', (mode) => {
  expect(hasSearchShapingFlags({ binary_files: mode })).toBe(true)
})
it.each([
  ['hello 😀', true],
  ['hello\0tail', false],
  ['hello\udcff', false],
] as const)('checks provider snippets %j', (text, expected) => {
  expect(textSearchResults([text])).toBe(expected)
})
