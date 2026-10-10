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
import { RegexSyntax } from './types.ts'
import {
  grepSearchMeta,
  grepSearchOptions,
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
  searchTerms,
  textCandidates,
  wholeWordLiteral,
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
    ['(?:foo)?bar', 'bar'],
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
    expect(searchQuery('fo\\(bar\\)\\?baz', false, RegexSyntax.BASIC)).toBe('baz')
    expect(searchQuery('(foo)?bar', false, RegexSyntax.BASIC)).toBe('foo')
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
    [{ no_messages: true }, true],
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
    [{ args_I: true }, true],
    [{ text: true }, true],
    // rg -L walks links, which no backend's search can see.
    [{ follow: true }, true],
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
    vfsPath: stripSlash(virtual),
    pattern,
    resolved: pattern === null,
  })
}

const EMAIL_HONORED = ['n', 'args_l', 'w', 'o', 'm']
const EMAIL_RG_HONORED = [
  'line_number',
  'files_with_matches',
  'word_regexp',
  'only_matching',
  'max_count',
  'line_regexp',
]

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

// The filter dests are read the way python reads them: the repeatable ones
// through `asList` and the single-valued ones through `asStr`, and the count
// dests through `asInt`. One flat list tested with `!== undefined` and
// `typeof === 'string'` answered differently from python for all three
// shapes below, so the two hosts could disagree about whether a grep/rg
// push-down was safe (issue #1089 item 11a).
describe('hasSearchShapingFlags matches the python filter split', () => {
  it('reads a count dest as a number, not only as a numeric string', () => {
    // python's `fl.as_int("m")` sees both; `typeof flags.m === 'string'` saw
    // only the string, so a numeric value let an unsafe push-down through.
    expect(hasSearchShapingFlags({ m: '3' })).toBe(true)
    expect(hasSearchShapingFlags({ m: 3 })).toBe(true)
    expect(hasSearchShapingFlags({ A: 2 })).toBe(true)
    expect(hasSearchShapingFlags({ B: 2 })).toBe(true)
    expect(hasSearchShapingFlags({ C: 2 })).toBe(true)
  })

  it('reads a repeatable filter dest as a list', () => {
    expect(hasSearchShapingFlags({ include: ['*.py'] })).toBe(true)
    expect(hasSearchShapingFlags({ exclude: ['*.log'] })).toBe(true)
    expect(hasSearchShapingFlags({ exclude_dir: ['node_modules'] })).toBe(true)
    // An empty list is "not supplied", as `fl.as_list` reports it; the flat
    // `!== undefined` test called it supplied and deferred.
    expect(hasSearchShapingFlags({ include: [] })).toBe(false)
  })

  it('reads a single-valued filter dest as a string', () => {
    expect(hasSearchShapingFlags({ type: 'py' })).toBe(true)
    expect(hasSearchShapingFlags({ glob: '*.py' })).toBe(true)
    expect(hasSearchShapingFlags({ binary_files: 'text' })).toBe(true)
    // A bare boolean is not a value, as `fl.as_str` reports it.
    expect(hasSearchShapingFlags({ glob: true })).toBe(false)
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
    expect(hasSearchShapingFlags({ invert_match: true }, EMAIL_RG_HONORED)).toBe(true)
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
    expect(pushdownOperand([dash], {}, 'ada')).toBe(null)
    expect(literalPushdownOperand([dash], {}, 'ada')).toBe(null)
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

it.each([
  { mode: 'semantic' },
  { mode: 'literal', stream: null },
  { mode: 'literal', typo: true },
  null,
])('rejects invalid grep metadata %j', (grep) => {
  expect(() => grepSearchMeta({ search: () => Promise.resolve([]), meta: { grep } })).toThrow()
})

it.each([{ ignore_case: 'true' }, { typo: true }, null])(
  'rejects invalid grep options %j',
  (grep) => {
    expect(() => grepSearchOptions({ query: 'query', options: { grep } })).toThrow()
  },
)

it('leaves resource namespaces opaque and treats plain queries as literal', () => {
  expect(grepSearchOptions({ query: 'a.*b', options: { limit: 20 } }).fixedString).toBe(true)
  expect(grepSearchMeta({ search: () => Promise.resolve([]), meta: { semantic: true } })).toBeNull()
})

// Twins of test_whole_word_literal_is_the_term_a_word_index_answers_for and
// test_text_candidates_drops_what_a_walk_never_reads in
// python/tests/commands/builtin/test_grep_pushdown.py.
describe('wholeWordLiteral', () => {
  it.each<[string | null, boolean, boolean, string | null]>([
    ['import', false, true, 'import'],
    ['import', true, true, 'import'],
    ['import os', false, true, 'import os'],
    ['import', false, false, null],
    ['import.*os', false, true, null],
    ['import.*os', true, true, 'import.*os'],
    ['foo|bar', false, true, null],
    ['a\nb', true, true, null],
    [null, false, true, null],
  ])('answers %j (fixed=%s, -w=%s) with %j', (pattern, fixed, wholeWord, expected) => {
    // Only a whole-word literal is what the index is asked for: without -w
    // a word index under-fetches substrings, a regex narrows on a term that
    // is only part of the match, and a pattern list has no required term.
    expect(wholeWordLiteral(pattern, fixed, wholeWord)).toBe(expected)
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

describe('textCandidates', () => {
  it('drops what a walk never reads', () => {
    const paths = ['/a.py', '/m.gguf', '/b.txt', '/w.bin', '/README'].map((p) =>
      PathSpec.fromStrPath(p),
    )
    expect(textCandidates(paths).map((p) => p.virtual)).toEqual(['/a.py', '/b.txt', '/README'])
    expect(textCandidates([])).toEqual([])
  })
})
