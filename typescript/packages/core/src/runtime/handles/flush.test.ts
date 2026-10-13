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
import { applyFlush, planFlush } from './flush.ts'

const enc = new TextEncoder()

describe('planFlush', () => {
  it.each<[string, Partial<Parameters<typeof planFlush>[0]>, ReturnType<typeof planFlush>]>([
    [
      'sends only the ranges of a created file',
      {
        baseLen: 0,
        runs: [
          [0, enc.encode('ab')],
          [3, enc.encode('c')],
        ],
        size: 4,
      },
      [
        { kind: 'pwrite', data: enc.encode('ab'), offset: 0 },
        { kind: 'pwrite', data: enc.encode('c'), offset: 3 },
      ],
    ],
    [
      'keeps a range at the end at its offset',
      { runs: [[3, enc.encode('XYZ')]], size: 6 },
      [{ kind: 'pwrite', data: enc.encode('XYZ'), offset: 3 }],
    ],
    [
      'appends for an append-mode handle',
      { runs: [[3, enc.encode('XYZ')]], size: 6, appending: true },
      [{ kind: 'append', data: enc.encode('XYZ') }],
    ],
    [
      'appends for an append-mode handle even to an empty file',
      { baseLen: 0, runs: [[0, enc.encode('x')]], size: 1, appending: true },
      [{ kind: 'append', data: enc.encode('x') }],
    ],
    [
      'sends edits as pwrites in order',
      {
        runs: [
          [0, enc.encode('a')],
          [2, enc.encode('c')],
        ],
      },
      [
        { kind: 'pwrite', data: enc.encode('a'), offset: 0 },
        { kind: 'pwrite', data: enc.encode('c'), offset: 2 },
      ],
    ],
    [
      'cuts first and grows last',
      { baseLen: 6, cut: 2, runs: [[4, enc.encode('z')]], size: 8 },
      [
        { kind: 'truncate', length: 2 },
        { kind: 'pwrite', data: enc.encode('z'), offset: 4 },
        { kind: 'truncate', length: 8 },
      ],
    ],
    ['grows alone with one truncate', { size: 5 }, [{ kind: 'truncate', length: 5 }]],
  ])('%s', (_name, facts, steps) => {
    expect(
      planFlush({ baseLen: 3, runs: [], cut: null, size: 3, appending: false, ...facts }),
    ).toEqual(steps)
  })
})

describe('applyFlush', () => {
  it('lands ranges, gaps and cuts as a mount does', () => {
    // A range past the end leaves zeros between, and a cut then a growth
    // reads zeros where the cut bytes were.
    const enc = new TextEncoder()
    const out = applyFlush(enc.encode('hello'), [
      { kind: 'pwrite', data: enc.encode('X'), offset: 8 },
      { kind: 'truncate', length: 3 },
      { kind: 'truncate', length: 6 },
      { kind: 'append', data: enc.encode('Z') },
    ])
    expect([...out]).toEqual([...enc.encode('hel'), 0, 0, 0, ...enc.encode('Z')])
    expect(applyFlush(enc.encode('hello'), [{ kind: 'write', data: enc.encode('new') }])).toEqual(
      enc.encode('new'),
    )
    // A cut hands back bytes of its own size, not a view over the old file.
    expect(
      applyFlush(new Uint8Array(1024), [{ kind: 'truncate', length: 0 }]).buffer.byteLength,
    ).toBe(0)
  })
})
