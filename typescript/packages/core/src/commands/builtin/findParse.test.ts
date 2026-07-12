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
import { evalPredicate } from './findEval.ts'
import { FindParseError, parseFindExpression } from './findParse.ts'

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

  it('throws FindParseError on invalid numeric / size args', () => {
    expect(() => parseFindExpression(['-maxdepth', 'abc'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-mindepth', 'x'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-size', ''])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-size', 'abc'])).toThrow(FindParseError)
    expect(() => parseFindExpression(['-mtime', ''])).toThrow(FindParseError)
  })

  it('throws on unsupported predicates', () => {
    for (const toks of [['-regex', '.*'], ['-newer', 'a'], ['-prune'], ['-nam', 'x']]) {
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
})
