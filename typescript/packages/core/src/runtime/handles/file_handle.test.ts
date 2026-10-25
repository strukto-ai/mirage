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
import { overlaid, writeRuns } from './file_handle.ts'

const enc = new TextEncoder()

describe('writeRuns', () => {
  it('folds a sequential stream into one run', () => {
    expect(
      writeRuns([
        [0, enc.encode('ab')],
        [2, enc.encode('cd')],
        [4, enc.encode('e')],
      ]),
    ).toEqual([[0, enc.encode('abcde')]])
    expect(writeRuns([])).toEqual([])
  })

  it('keeps scattered writes apart and in order', () => {
    expect(
      writeRuns([
        [4, enc.encode('xy')],
        [0, enc.encode('abcdef')],
      ]),
    ).toEqual([
      [4, enc.encode('xy')],
      [0, enc.encode('abcdef')],
    ])
  })
})

describe('overlaid', () => {
  const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

  it('lays writes over the stored window in arrival order', () => {
    const writes: [number, Uint8Array][] = [
      [1, enc('XY')],
      [2, enc('Z')],
    ]
    expect(overlaid(enc('abcd'), 0, 4, writes)).toEqual(enc('aXZd'))
    expect(overlaid(enc('cd'), 2, 2, writes)).toEqual(enc('Zd'))
  })

  it('grows the file and reads a gap as zeros', () => {
    expect(overlaid(enc('ab'), 0, 10, [[4, enc('Q')]])).toEqual(enc('ab\0\0Q'))
    expect(overlaid(new Uint8Array(), 8, 4, [[4, enc('Q')]])).toEqual(new Uint8Array())
  })
})
