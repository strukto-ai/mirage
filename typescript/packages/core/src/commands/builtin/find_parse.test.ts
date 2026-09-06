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
import { evalPredicate } from './find_eval.ts'
import { FindParseError } from '../errors.ts'
import { parseFindExpression } from './find_parse.ts'

describe('parseFindExpression', () => {
  it('negation', () => {
    expect(parseFindExpression(['-not', '-name', '*.txt']).tree).toEqual({
      op: 'not',
      kid: { op: 'name', pattern: '*.txt', icase: false },
    })
    expect(parseFindExpression(['!', '-name', 'x']).tree).toEqual({
      op: 'not',
      kid: { op: 'name', pattern: 'x', icase: false },
    })
  })

  it('or', () => {
    expect(parseFindExpression(['-name', 'a', '-o', '-name', 'b']).tree).toEqual({
      op: 'or',
      kids: [
        { op: 'name', pattern: 'a', icase: false },
        { op: 'name', pattern: 'b', icase: false },
      ],
    })
  })

  it('or lower precedence than implicit and', () => {
    expect(parseFindExpression(['-name', 'a', '-o', '-name', 'b', '-name', 'c']).tree).toEqual({
      op: 'or',
      kids: [
        { op: 'name', pattern: 'a', icase: false },
        {
          op: 'and',
          kids: [
            { op: 'name', pattern: 'b', icase: false },
            { op: 'name', pattern: 'c', icase: false },
          ],
        },
      ],
    })
  })

  it('grouping', () => {
    expect(
      parseFindExpression(['(', '-name', 'a', '-o', '-name', 'b', ')', '-type', 'f']).tree,
    ).toEqual({
      op: 'and',
      kids: [
        {
          op: 'or',
          kids: [
            { op: 'name', pattern: 'a', icase: false },
            { op: 'name', pattern: 'b', icase: false },
          ],
        },
        { op: 'type', kind: 'f' },
      ],
    })
  })

  it('globals extracted', () => {
    const e = parseFindExpression(['-maxdepth', '2', '-mindepth', '1', '-name', 'x'])
    expect(e.maxDepth).toBe(2)
    expect(e.minDepth).toBe(1)
    expect(evalPredicate(e.tree, { key: '/x', name: 'x', kind: 'f', depth: 1 })).toBe(true)
    expect(evalPredicate(e.tree, { key: '/y', name: 'y', kind: 'f', depth: 1 })).toBe(false)
  })

  it('depthFirst is -depth or -delete', () => {
    expect(parseFindExpression(['-depth']).depthFirst).toBe(true)
    expect(parseFindExpression(['-delete']).depthFirst).toBe(true)
    expect(parseFindExpression(['-print']).depthFirst).toBe(false)
  })

  it('size extracted as global', () => {
    const e = parseFindExpression(['-size', '+50c'])
    expect(e.minSize).toBe(51)
    expect(e.maxSize).toBeNull()
  })

  it('size bounds follow GNU strictness', () => {
    let e = parseFindExpression(['-size', '+0c'])
    expect([e.minSize, e.maxSize]).toEqual([1, null])
    e = parseFindExpression(['-size', '-2c'])
    expect([e.minSize, e.maxSize]).toEqual([null, 1])
    e = parseFindExpression(['-size', '2c'])
    expect([e.minSize, e.maxSize]).toEqual([2, 2])
  })

  it('intersects top-level windows and widens them under -o', () => {
    // GNU: every test in the implicit -a chain must hold, so `-newermt a
    // -newermt b` keeps what is newer than both and `-mtime +2 -mtime -1`
    // keeps nothing; under -o the flat window can only widen.
    const later = parseFindExpression(['-newermt', '2021-06-01']).mtimeMin
    for (const order of [
      ['2020-06-01', '2021-06-01'],
      ['2021-06-01', '2020-06-01'],
    ]) {
      const e = parseFindExpression(['-newermt', order[0] ?? '', '-newermt', order[1] ?? ''])
      expect([e.mtimeMin, e.mtimeMax]).toEqual([later, null])
    }
    const empty = parseFindExpression(['-mtime', '+2', '-mtime', '-1'])
    expect(empty.mtimeMin).not.toBeNull()
    expect(empty.mtimeMax).not.toBeNull()
    expect(empty.mtimeMin ?? 0).toBeGreaterThan(empty.mtimeMax ?? 0)
    const both = parseFindExpression(['-mtime', '-1', '-mtime', '-3'])
    const either = parseFindExpression(['-mtime', '-1', '-o', '-mtime', '-3'])
    expect((both.mtimeMin ?? 0) - (either.mtimeMin ?? 0)).toBeCloseTo(2 * 86400, 0)
    expect([both.mtimeMax, either.mtimeMax]).toEqual([null, null])
  })

  it('repeated -mtime windows merge to their union', () => {
    // `-mtime +0 -o -mtime -1` is a tautology in GNU; the flat window
    // must impose no bounds rather than keep only the last predicate.
    let e = parseFindExpression(['-mtime', '+0', '-o', '-mtime', '-1'])
    expect([e.mtimeMin, e.mtimeMax]).toEqual([null, null])
    e = parseFindExpression(['-mtime', '-1'])
    expect(e.mtimeMin).not.toBeNull()
    expect(e.mtimeMax).toBeNull()
    e = parseFindExpression(['-mtime', '1', '-o', '-mtime', '3'])
    expect(e.mtimeMin).not.toBeNull()
    expect(e.mtimeMax).not.toBeNull()
    expect((e.mtimeMax ?? 0) - (e.mtimeMin ?? 0)).toBeCloseTo(3 * 86400, 0)
  })

  it('size rounds up to the unit like GNU', () => {
    // GNU -size -1k keeps only empty files; 1k keeps 1..1024 bytes;
    // +1k excludes a file of exactly 1024 bytes.
    let e = parseFindExpression(['-size', '-1k'])
    expect([e.minSize, e.maxSize]).toEqual([null, 0])
    e = parseFindExpression(['-size', '1k'])
    expect([e.minSize, e.maxSize]).toEqual([1, 1024])
    e = parseFindExpression(['-size', '+1k'])
    expect([e.minSize, e.maxSize]).toEqual([1025, null])
  })

  it('empty expression is true', () => {
    expect(parseFindExpression([]).tree).toEqual({ op: 'true' })
  })

  it('throws on unknown / unbalanced', () => {
    expect(() => parseFindExpression(['-bogus'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['(', '-name', 'a'])).toThrow(FindParseError)
  })

  it('refuses -exec outside a top-level -a chain, on either side of -o', () => {
    const placement =
      'find: -exec is supported only in a top-level -a chain, not under -o, ! or parentheses'
    for (const tokens of [
      ['-name', 'a', '-o', '-exec', 'echo', '{}', ';'],
      ['-exec', 'false', '{}', ';', '-o', '-print'],
      ['!', '-exec', 'false', ';'],
      ['(', '-exec', 'false', ';', ')'],
    ]) {
      expect(() => parseFindExpression(tokens)).toThrow(placement)
    }
    expect(parseFindExpression(['-type', 'f', '-exec', 'echo', '{}', ';']).actions).toHaveLength(1)
  })

  it('throws FindParseError on invalid numeric / size args', () => {
    expect(() => parseFindExpression(['-maxdepth', 'abc'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-mindepth', 'x'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-size', ''])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-size', 'abc'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-mtime', ''])).toThrow(FindParseError)
  })

  it('refuses trailing garbage after the digits', () => {
    expect(() => parseFindExpression(['-maxdepth', '12abc'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-mindepth', '2x'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-size', '12ab'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-mtime', '3x'])).toThrow(FindParseError)
  })

  it('throws on unsupported predicates', () => {
    for (const toks of [['-regex', '.*'], ['-perm', '644'], ['-prune'], ['-nam', 'x']]) {
      expect(() => parseFindExpression(toks)).toThrow(FindParseError)
    }
  })

  it('accepts valid -type letters and rejects invalid ones', () => {
    for (const t of ['b', 'c', 'd', 'p', 'f', 'l', 's']) {
      expect(parseFindExpression(['-type', t]).tree).toEqual({ op: 'type', kind: t })
    }
    for (const bad of ['x', 'z', 'dir']) {
      expect(() => parseFindExpression(['-type', bad])).toThrow(FindParseError)
    }
  })

  it('throws (not stack-overflow) on deeply nested expressions', () => {
    const open: string[] = Array.from({ length: 500 }, () => '(')
    const close: string[] = Array.from({ length: 500 }, () => ')')
    expect(() => parseFindExpression([...open, '-name', 'x', ...close])).toThrow(FindParseError)
    const nots: string[] = Array.from({ length: 500 }, () => '-not')
    expect(() => parseFindExpression([...nots, '-name', 'x'])).toThrow(FindParseError)
  })

  // GNU findutils 4.10.0, pinned on debian:stable-slim. Reachable only
  // since `!` became an expression token: a dangling `!` used to be a start
  // point, so find printed the whole tree and blamed a missing path.
  it('names the operator a line left without a right-hand side', () => {
    const cases: [string[], string][] = [
      [['!'], '!'],
      [['-not'], '-not'],
      [['-name', 'a', '!'], '!'],
      [['-name', 'a', '-not'], '-not'],
      [['!', '!'], '!'],
      [['-name', 'a', '-a'], '-a'],
      [['-name', 'a', '-and'], '-and'],
      [['-name', 'a', '-o'], '-o'],
      [['-name', 'a', '-or'], '-or'],
    ]
    for (const [toks, op] of cases) {
      expect(() => parseFindExpression(toks)).toThrow(`find: expected an expression after '${op}'`)
    }
  })

  it('names both sides when a ) closes the empty slot', () => {
    const cases: [string[], string][] = [
      [['(', '!', ')'], '!'],
      [['(', '-not', ')'], '-not'],
      [['(', '-name', 'a', '-a', ')'], '-a'],
      [['(', '-name', 'a', '-and', ')'], '-and'],
      [['(', '-name', 'a', '-o', ')'], '-o'],
      [['(', '-name', 'a', '-or', ')'], '-or'],
    ]
    for (const [toks, op] of cases) {
      expect(() => parseFindExpression(toks)).toThrow(
        `find: expected an expression between '${op}' and ')'`,
      )
    }
  })
})

describe('find -printf parsing', () => {
  it('stores the format on the expression', () => {
    const expr = parseFindExpression(['-printf', '%p\\n'])
    expect(expr.printf).toBe('%p\\n')
  })

  it('refuses a missing argument', () => {
    expect(() => parseFindExpression(['-printf'])).toThrow("missing argument to '-printf'")
  })

  it('combines with tests', () => {
    const expr = parseFindExpression(['-name', '*.txt', '-printf', '%f\\n'])
    expect(expr.printf).toBe('%f\\n')
  })
})

describe('-newermt GNU dates', () => {
  it.each([
    ['yesterday', 86400],
    ['24 hours ago', 86400],
    ['now', 0],
  ] as const)('accepts %s', (operand, seconds) => {
    const before = Date.now() / 1000
    const expr = parseFindExpression(['-newermt', operand])
    expect(expr.mtimeMin).toBeGreaterThanOrEqual(before - seconds)
    expect(expr.mtimeMin).toBeLessThanOrEqual(Date.now() / 1000 - seconds + 0.001)
  })
  it('accepts epoch timestamps', () => {
    const expr = parseFindExpression(['-newermt', '@1700000000'])
    expect(expr.mtimeMin).toBeGreaterThan(1700000000)
    expect(expr.mtimeMin).toBeLessThan(1700000000.001)
  })
})

describe('tests after actions', () => {
  for (const action of [
    ['-exec', 'echo', '{}', ';'],
    ['-exec', 'echo', '{}', '+'],
    ['-print'],
    ['-delete'],
    ['-printf', '%p'],
  ]) {
    it.each(
      [
        ['-name', '*.txt'],
        ['-type', 'f'],
        ['-size', '+1c'],
        ['-newermt', 'yesterday'],
        ['-newer', 'ref'],
        ['-empty'],
        ['!', '-name', '*.txt'],
        ['(', '-name', '*.txt', ')'],
      ].map((test) => [test]),
    )(`refuses a later test after ${action.join(' ')}`, (test) => {
      expect(() => parseFindExpression([...action, ...test])).toThrow(
        'tests after actions are not supported',
      )
    })
  }
})

describe('action placement', () => {
  for (const action of [['-print'], ['-print0'], ['-ls'], ['-delete'], ['-printf', '%p']]) {
    it.each([
      [...action, '-o', '-print'],
      ['-name', 'keep', '-o', ...action],
      ['!', ...action],
      ['(', ...action, ')'],
    ])(`refuses detached ${action[0] ?? ''}: %j`, (...tokens) => {
      expect(() => parseFindExpression(tokens)).toThrow('supported only in a top-level')
    })
    it(`allows ${action[0] ?? ''} after grouped tests`, () => {
      expect(() =>
        parseFindExpression(['(', '-name', 'a', '-o', '-name', 'b', ')', ...action]),
      ).not.toThrow()
    })
  }
})

it.each([
  '2026-02-31',
  '2025-02-29',
  '2026-04-31',
  '2026-00-01',
  '2026-13-01',
  '2026-01-00',
  '2026-01-32',
  '2026-02-31T12:00:00Z',
  '2026-02-31 1 day',
  '2026-01-01T24:00:00',
  '2026-01-01T12:60:00',
])('rejects invalid calendar fields: %s', (value) => {
  expect(() => parseFindExpression(['-newermt', value])).toThrow('I cannot figure out')
})

it.each([
  [
    ['-newer', 'ref', '-o', '-name', 'keep'],
    'find: -newer is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [
    ['-name', 'keep', '-o', '-newer', 'ref'],
    'find: -newer is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [
    ['!', '-newer', 'ref'],
    'find: -newer is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [
    ['(', '-newer', 'ref', ')'],
    'find: -newer is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [
    ['-newermt', '2000-01-01', '-o', '-name', 'keep'],
    'find: -newermt is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [
    ['-name', 'keep', '-o', '-newermt', '2000-01-01'],
    'find: -newermt is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [
    ['!', '-newermt', '2000-01-01'],
    'find: -newermt is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [
    ['(', '-newermt', '2000-01-01', ')'],
    'find: -newermt is supported only in a top-level -a chain, not under -o, ! or parentheses',
  ],
  [['-printf', '%p\\n', '-exec', 'true', '{}', ';'], 'find: -exec cannot be combined with -printf'],
  [['-exec', 'true', '{}', ';', '-printf', '%p\\n'], 'find: -exec cannot be combined with -printf'],
  [['-printf', '%p\\n', '-print'], 'find: -printf cannot be combined with other actions'],
  [['-print', '-printf', '%p\\n'], 'find: -printf cannot be combined with other actions'],
  [['-printf', '%p\\n', '-print0'], 'find: -printf cannot be combined with other actions'],
  [['-print0', '-printf', '%p\\n'], 'find: -printf cannot be combined with other actions'],
  [['-printf', '%p\\n', '-ls'], 'find: -printf cannot be combined with other actions'],
  [['-ls', '-printf', '%p\\n'], 'find: -printf cannot be combined with other actions'],
  [['-printf', '%p\\n', '-delete'], 'find: -printf cannot be combined with other actions'],
  [['-delete', '-printf', '%p\\n'], 'find: -printf cannot be combined with other actions'],
  [['-printf', '%p', '-printf', '%f'], 'find: multiple -printf actions are not supported'],
])('refuses detached newer tests and mixed printf: %s', (tokens, message) => {
  expect(() => parseFindExpression(tokens)).toThrow(message)
})
