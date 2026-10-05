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
import { READ_CHUNK } from './constants.ts'
import { FileHandle, writeRuns } from './file_handle.ts'
import type { FileFetch } from './types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function over(text: string | Uint8Array, calls?: [number, number | null][]): FileFetch {
  const data = typeof text === 'string' ? enc.encode(text) : text
  return (offset, size) => {
    calls?.push([offset, size])
    return Promise.resolve(size === null ? data.slice(offset) : data.slice(offset, offset + size))
  }
}

function handle(text: string, mode: { writable?: boolean; append?: boolean } = {}): FileHandle {
  return FileHandle.opened('/f', over(text), {
    size: enc.encode(text).length,
    writable: mode.writable ?? true,
    append: mode.append ?? false,
  })
}

/** What a synchronous guest does: fill until nothing lacks, then read. */
async function read(h: FileHandle, size: number): Promise<string> {
  while (h.lacks(size)) await h.fill(size)
  return dec.decode(h.read(size))
}

describe('FileHandle', () => {
  it('reads nothing at open and fetches a small file whole', async () => {
    const calls: [number, number | null][] = []
    const h = FileHandle.opened('/f', over('hello', calls), {
      size: 5,
      writable: false,
      append: false,
    })
    expect(calls).toEqual([])
    expect(await read(h, 2)).toBe('he')
    expect(await read(h, -1)).toBe('llo')
    expect(calls).toEqual([[0, null]])
  })

  it('finds the end of a file whose size was unknown', async () => {
    const h = FileHandle.opened('/f', over('abc'), { size: 0, writable: false, append: false })
    expect(h.eof).toBe(false)
    expect(await read(h, -1)).toBe('abc')
    expect(h.eof).toBe(true)
  })

  it('fetches a large file a chunk at a time', async () => {
    const calls: [number, number | null][] = []
    const data = new Uint8Array(READ_CHUNK + 10).fill(120)
    const h = FileHandle.opened('/f', over(data, calls), {
      size: data.length,
      writable: false,
      append: false,
    })
    h.seek(READ_CHUNK + 5, 0)
    expect(await read(h, 3)).toBe('xxx')
    expect(calls).toEqual([[READ_CHUNK + 5, READ_CHUNK]])
  })

  it('writes at the end every time in append mode', async () => {
    const h = handle('abc', { append: true })
    expect(h.pos).toBe(3)
    h.seek(0, 0)
    h.write(enc.encode('XY'))
    h.seek(0, 0)
    expect(await read(h, 9)).toBe('abcXY')
    expect(h.flushPlan()).toEqual([{ kind: 'append', data: enc.encode('XY') }])
  })

  it('owes only the range an edit wrote', async () => {
    const h = handle('0123456789')
    h.seek(5, 0)
    h.write(enc.encode('BB'))
    h.seek(0, 0)
    expect(await read(h, 10)).toBe('01234BB789')
    expect(h.flushPlan()).toEqual([{ kind: 'pwrite', data: enc.encode('BB'), offset: 5 }])
  })

  it('joins the ranges a write touches, a later write winning', () => {
    const h = handle('0123456789')
    h.pwrite(6, enc.encode('x'))
    h.pwrite(1, enc.encode('ab'))
    h.pwrite(2, enc.encode('CDEF'))
    expect(h.flushPlan()).toEqual([{ kind: 'pwrite', data: enc.encode('aCDEFx'), offset: 1 }])
  })

  it('reads the gap a write past the end leaves as zeros', async () => {
    const h = handle('ab')
    h.pwrite(4, enc.encode('Z'))
    expect(h.size).toBe(5)
    await h.fill(-1)
    expect(h.pread(0, 9)).toEqual(enc.encode('ab\0\0Z'))
  })

  it('sends only the ranges of a created file', () => {
    const h = FileHandle.opened('/f', null, { size: 0, writable: true, append: false })
    h.write(enc.encode('new'))
    h.pwrite(5, enc.encode('!'))
    expect(h.flushPlan()).toEqual([
      { kind: 'pwrite', data: enc.encode('new'), offset: 0 },
      { kind: 'pwrite', data: enc.encode('!'), offset: 5 },
    ])
  })

  it('cuts, then writes ranges, then grows', async () => {
    const h = handle('0123456789')
    h.pwrite(8, enc.encode('xy'))
    h.truncate(4)
    h.pwrite(6, enc.encode('Q'))
    h.truncate(9)
    await h.fill(-1)
    expect(h.pread(0, 10)).toEqual(enc.encode('0123\0\0Q\0\0'))
    expect(h.flushPlan()).toEqual([
      { kind: 'truncate', length: 4 },
      { kind: 'pwrite', data: enc.encode('Q'), offset: 6 },
      { kind: 'truncate', length: 9 },
    ])
  })

  it('reads lines across what it wrote and what was stored', async () => {
    const h = handle('one\ntwo\nthree')
    h.pwrite(4, enc.encode('TWO'))
    const lines: string[] = []
    for (;;) {
      while (h.lacksLine()) await h.fill(0)
      const line = h.readLine()
      if (line === null) break
      lines.push(dec.decode(line))
    }
    expect(lines).toEqual(['one', 'TWO', 'three'])
    expect(h.eof).toBe(true)
  })

  it('reads a line on through a stored newline a write covered', async () => {
    const tail = 'x'.repeat(READ_CHUNK)
    const h = handle(`ab\n${tail}\nend`)
    h.pwrite(2, enc.encode('Z'))
    const lines: string[] = []
    for (;;) {
      while (h.lacksLine()) await h.fill(0)
      const line = h.readLine()
      if (line === null) break
      lines.push(dec.decode(line))
    }
    expect(lines).toEqual([`abZ${tail}`, 'end'])
  })

  it('owes nothing when it only read', async () => {
    const h = handle('abc')
    await read(h, -1)
    expect(h.dirty).toBe(false)
    expect(h.flushPlan()).toEqual([])
  })

  it('answers null for a bad whence or a negative target', () => {
    const h = handle('hello', { writable: false })
    expect(h.seek(-2, 2)).toBe(3)
    expect(h.seek(-9, 0)).toBeNull()
    expect(h.seek(0, 7)).toBeNull()
    expect(h.pos).toBe(3)
  })
})

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
