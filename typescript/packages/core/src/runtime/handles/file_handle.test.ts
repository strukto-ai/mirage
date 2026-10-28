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
import { ByteSlice, ByteSpool } from '../../io/spool.ts'
import { materialize } from '../../io/types.ts'
import { overlaid, runGroups, runStream, windowWrites, writeRuns } from './file_handle.ts'

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

describe('runGroups', () => {
  it('holds the writes each run folds', () => {
    const writes: [number, Uint8Array][] = [
      [0, enc.encode('ab')],
      [1, enc.encode('X')],
      [2, enc.encode('cd')],
      [10, enc.encode('q')],
      [0, enc.encode('z')],
    ]
    const groups = runGroups(writes)
    expect(groups.map((group) => group.length)).toEqual([3, 1, 1])
    expect(groups.map((group) => writeRuns(group as [number, Uint8Array][])[0])).toEqual(
      writeRuns(writes),
    )
  })
})

describe('windowWrites', () => {
  it('reads a spooled write for the window alone', async () => {
    const spool = new ByteSpool()
    await spool.append(enc.encode('0123456789'))
    const writes: [number, Uint8Array | ByteSlice][] = [
      [100, new ByteSlice(spool, 0, 10)],
      [104, enc.encode('XY')],
    ]
    expect(await windowWrites(writes, 102, 4)).toEqual([
      [102, enc.encode('2345')],
      [110, new Uint8Array()],
      [104, enc.encode('XY')],
    ])
    const laid = await windowWrites(writes, 96, 2)
    expect(laid).toEqual([
      [110, new Uint8Array()],
      [104, enc.encode('XY')],
    ])
    expect(overlaid(new Uint8Array(), 96, 2, laid)).toEqual(new Uint8Array(2))
    await spool.close()
    expect(await windowWrites(writes, 102, 4)).toEqual([[104, enc.encode('XY')]])
  })
})

describe('runStream', () => {
  it('leaves what the folded run holds', async () => {
    const data = Uint8Array.from({ length: 2621440 }, (_, i) => i % 256)
    const spool = new ByteSpool()
    await spool.append(data)
    const group: [number, Uint8Array | ByteSlice][] = [
      [0, new ByteSlice(spool, 0, data.byteLength)],
      [2, enc.encode('XY')],
      [data.byteLength, enc.encode('tail')],
    ]
    const folded = writeRuns([
      [0, data],
      [2, enc.encode('XY')],
      [data.byteLength, enc.encode('tail')],
    ])
    expect(await materialize(runStream(group))).toEqual(folded[0]?.[1])
    await spool.close()
  })
})
