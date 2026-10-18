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

import { combinedLines, pairing } from './combined.ts'

function numbers(count: number, edits: Record<number, string> = {}): string[] {
  return Array.from({ length: count }, (_, i) => `${edits[i + 1] ?? String(i + 1)}\n`)
}

describe('combinedLines', () => {
  it('has no hunk when the result matches every parent', () => {
    const lines = numbers(5)
    expect(combinedLines([lines, lines], lines, true)).toEqual([])
  })

  it('marks each parent column for a conflict resolution', () => {
    expect(
      combinedLines(
        [
          ['a\n', 'MAIN\n', 'c\n'],
          ['a\n', 'SIDE\n', 'c\n'],
        ],
        ['a\n', 'BOTH\n', 'c\n'],
        true,
      ),
    ).toEqual(['@@@ -1,3 -1,3 +1,3 @@@\n', '  a\n', '- MAIN\n', ' -SIDE\n', '++BOTH\n', '  c\n'])
  })

  it('drops a clean merge of distant edits only when dense', () => {
    const ours = numbers(20, { 8: 'eight' }),
      theirs = numbers(20, { 2: 'two' }),
      result = numbers(20, { 2: 'two', 8: 'eight' })
    expect(combinedLines([ours, theirs], result, true)).toEqual([])
    expect(combinedLines([ours, theirs], result, false)[0]).toBe('@@@ -1,11 -1,11 +1,11 @@@\n')
  })

  it('keeps edits from both sides within context when dense', () => {
    const ours = numbers(20, { 5: 'five' }),
      theirs = numbers(20, { 2: 'two' }),
      result = numbers(20, { 2: 'two', 5: 'five' })
    expect(combinedLines([ours, theirs], result, true)).toEqual([
      '@@@ -1,8 -1,8 +1,8 @@@\n',
      '  1\n',
      '- 2\n',
      '+ two\n',
      '  3\n',
      '  4\n',
      ' -5\n',
      ' +five\n',
      '  6\n',
      '  7\n',
      '  8\n',
    ])
  })

  it('numbers an empty side from one', () => {
    expect(combinedLines([[], []], ['new\n'], true)).toEqual([
      '@@@ -1,0 -1,0 +1,1 @@@\n',
      '++new\n',
    ])
    expect(combinedLines([['b\n'], ['b\n']], [], true)).toEqual([
      '@@@ -1,1 -1,1 +1,0 @@@\n',
      '--b\n',
    ])
  })

  it('carries function context in the header, less its last byte', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `  body ${String(i + 1)}\n`)
    lines[4] = 'function handleRequest(request, response) {\n'
    const ours = [...lines],
      theirs = [...lines],
      result = [...lines]
    ours[14] = '  MAIN\n'
    theirs[14] = '  SIDE\n'
    result[14] = '  BOTH\n'
    expect(combinedLines([ours, theirs], result, true)[0]).toBe(
      '@@@ -12,7 -12,7 +12,7 @@@ function handleRequest(request, respons\n',
    )
  })

  it('adds no marker for a missing final newline', () => {
    const body = combinedLines(
      [
        ['x\n', 'MAIN'],
        ['x\n', 'SIDE'],
      ],
      ['x\n', 'BOTH'],
      true,
    )
    expect(body.slice(-3)).toEqual(['- MAIN\n', ' -SIDE\n', '++BOTH\n'])
  })
})

it('keeps a valid empty result range for a zero-context deletion', () => {
  expect(combinedLines([['gone\n'], ['gone\n']], [], true, 0)).toEqual([
    '@@@ -1,1 -1,1 +1,0 @@@\n',
    '--gone\n',
  ])
})

describe('combinedLines folding and hunk edges', () => {
  it('folds lines three parents dropped in parent order', () => {
    const parents = [
      ['k\n', 'a\n', 'b\n', 'k2\n'],
      ['k\n', 'b\n', 'c\n', 'k2\n'],
      ['k\n', 'a\n', 'c\n', 'k2\n'],
    ]
    expect(combinedLines(parents, ['k\n', 'Z\n', 'k2\n'], false)).toEqual([
      '@@@@ -1,4 -1,4 -1,4 +1,3 @@@@\n',
      '   k\n',
      '- -a\n',
      '-- b\n',
      ' --c\n',
      '+++Z\n',
      '   k2\n',
    ])
  })

  it('pairs the later line when two folds are equally long', () => {
    const parents = [
      ['k\n', 'a\n', 'b\n', 'k2\n'],
      ['k\n', 'b\n', 'a\n', 'k2\n'],
    ]
    expect(combinedLines(parents, ['k\n', 'Z\n', 'k2\n'], true)).toEqual([
      '@@@ -1,4 -1,4 +1,3 @@@\n',
      '  k\n',
      '- a\n',
      '--b\n',
      ' -a\n',
      '++Z\n',
      '  k2\n',
    ])
  })

  it('pairs dropped lines across a missing final newline', () => {
    expect(
      combinedLines(
        [
          ['x\n', 'y'],
          ['x\n', 'y\n'],
        ],
        ['x\n', 'z\n'],
        true,
      ),
    ).toEqual(['@@@ -1,2 -1,2 +1,2 @@@\n', '  x\n', '--y\n', '++z\n'])
  })

  it('hides a clean drop inside a shown hunk but counts it when dense', () => {
    const ours = numbers(40, { 10: 'a', 17: 'b' })
    ours.splice(13, 0, 'Q\n')
    const theirs = numbers(40, { 10: 'c', 17: 'd' }),
      result = numbers(40, { 10: 'E1', 17: 'E2', 40: 'EVIL' })
    const dense = combinedLines([ours, theirs], result, true),
      loose = combinedLines([ours, theirs], result, false)
    expect(dense[0]).toBe('@@@ -7,15 -7,14 +7,14 @@@\n')
    expect(loose[0]).toBe(dense[0])
    expect(dense).not.toContain('- Q\n')
    expect(loose).toContain('- Q\n')
  })

  it('joins a dropped row to the next change at zero context', () => {
    const ours = ['1\n', '2\n', 'Q\n', '3\n', 'a\n', '5\n'],
      theirs = ['1\n', '2\n', '3\n', 'b\n', '5\n'],
      result = ['1\n', '2\n', '3\n', 'R\n', '5\n']
    expect(combinedLines([ours, theirs], result, true, 0)).toEqual([
      '@@@ -3,2 -3,1 +3,1 @@@\n',
      '- Q\n',
      '- a\n',
      ' -b\n',
      '++R\n',
    ])
  })

  it('names a hunk only from the lines skipped since the last one', () => {
    const named = { 12: 'func inside(', 20: 'func between(' }
    const ours = numbers(40, { ...named, 10: 'a', 30: 'a2' }),
      theirs = numbers(40, { ...named, 10: 'b', 30: 'b2' }),
      result = numbers(40, { ...named, 10: 'R1', 30: 'R2' })
    const body = combinedLines([ours, theirs], result, true)
    expect(body.filter((line) => line.startsWith('@@@'))).toEqual([
      '@@@ -7,7 -7,7 +7,7 @@@\n',
      '@@@ -27,7 -27,7 +27,7 @@@ func between\n',
    ])
  })
})

function referencePairing(left: string[], right: string[]): [number, number][] {
  const best = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  )
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      const row = best[i] ?? [],
        prev = best[i - 1] ?? []
      row[j] =
        left[i - 1] === right[j - 1]
          ? (prev[j - 1] ?? 0) + 1
          : Math.max(prev[j] ?? 0, row[j - 1] ?? 0)
    }
  }
  const pairs: [number, number][] = []
  let i = left.length,
    j = right.length
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      i--
      j--
      pairs.push([i, j])
    } else if ((best[i]?.[j - 1] ?? 0) >= (best[i - 1]?.[j] ?? 0)) {
      j--
    } else {
      i--
    }
  }
  return pairs.reverse()
}

describe('pairing within a row budget', () => {
  it('keeps the same pairs under a small row budget', () => {
    let seed = 5
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % bound
    }
    for (let trial = 0; trial < 300; trial++) {
      const letters = [2, 3, 6, 40][next(4)] ?? 2
      const left = Array.from({ length: next(40) }, () => String(next(letters)))
      const right = Array.from({ length: next(40) }, () => String(next(letters)))
      const want = referencePairing(left, right)
      for (const budget of [1, 7, 64, 400, 2 ** 26])
        expect(pairing(left, right, budget)).toEqual(want)
    }
  })

  it('allocates rows far below the product of two long drops', () => {
    const ours = Array.from({ length: 20000 }, (_, i) => `line ${String(i)}\n`)
    const theirs = ours.map((line, i) => (i % 10 === 0 ? `edit ${String(i)}\n` : line))
    const Real = globalThis.Uint32Array
    let words = 0
    class Counted extends Real {
      constructor(...args: unknown[]) {
        super(...(args as [ArrayBuffer, number, number]))
        if (typeof args[0] === 'number') words += args[0]
      }
    }
    globalThis.Uint32Array = Counted as typeof Uint32Array
    let body: string[]
    try {
      body = combinedLines([ours, theirs], [], true)
    } finally {
      globalThis.Uint32Array = Real
    }
    expect(body[0]).toBe('@@@ -1,20000 -1,20000 +1,0 @@@\n')
    expect(body).toHaveLength(1 + 20000 + 2000)
    // A row per line of one drop over the other would take 20,001 rows of
    // 625 words: 12.5M words before any mask.
    expect(words).toBeLessThan(2 ** 22)
  })
})

describe('combinedLines over a hunk longer than a call takes arguments', () => {
  it('lays out 200,000 lines new to both parents', () => {
    const body = combinedLines([[], []], numbers(200000), false)
    expect(body).toHaveLength(200001)
    expect(body[200000]).toBe('++200000\n')
  })

  it('lays out the same 100,000 lines dropped in opposite orders', () => {
    const lines = numbers(100000)
    const body = combinedLines([lines, [...lines].reverse()], [], false)
    // One line pairs; every other line is dropped by one parent alone.
    expect(body).toHaveLength(1 + 199999)
    expect(body[0]).toBe('@@@ -1,100000 -1,100000 +1,0 @@@\n')
  })
})
