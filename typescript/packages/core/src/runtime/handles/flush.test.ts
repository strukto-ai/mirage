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
import { planFlush } from './flush.ts'

const enc = new TextEncoder()

function plan(over: Partial<Parameters<typeof planFlush>[0]>): ReturnType<typeof planFlush> {
  return planFlush({
    fresh: false,
    baseLen: 3,
    runs: [],
    cut: null,
    size: 3,
    appending: false,
    ...over,
  })
}

describe('planFlush', () => {
  it('sends a created file whole with its gaps', () => {
    expect(
      plan({
        fresh: true,
        baseLen: 0,
        runs: [
          [0, enc.encode('ab')],
          [3, enc.encode('c')],
        ],
        size: 4,
      }),
    ).toEqual([{ kind: 'write', data: enc.encode('ab\0c') }])
  })

  it('sends a range at the end as an append', () => {
    expect(plan({ runs: [[3, enc.encode('XYZ')]], size: 6 })).toEqual([
      { kind: 'append', data: enc.encode('XYZ') },
    ])
  })

  it('appends for an append-mode handle even to an empty file', () => {
    expect(plan({ baseLen: 0, runs: [[0, enc.encode('x')]], size: 1, appending: true })).toEqual([
      { kind: 'append', data: enc.encode('x') },
    ])
  })

  it('sends edits as pwrites in order', () => {
    expect(
      plan({
        runs: [
          [0, enc.encode('a')],
          [2, enc.encode('c')],
        ],
      }),
    ).toEqual([
      { kind: 'pwrite', data: enc.encode('a'), offset: 0 },
      { kind: 'pwrite', data: enc.encode('c'), offset: 2 },
    ])
  })

  it('cuts first and grows last', () => {
    expect(plan({ baseLen: 6, cut: 2, runs: [[4, enc.encode('z')]], size: 8 })).toEqual([
      { kind: 'truncate', length: 2 },
      { kind: 'pwrite', data: enc.encode('z'), offset: 4 },
      { kind: 'truncate', length: 8 },
    ])
  })

  it('grows alone with one truncate', () => {
    expect(plan({ size: 5 })).toEqual([{ kind: 'truncate', length: 5 }])
  })
})
