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

import { describe, expect, it, vi } from 'vitest'
import type * as Constants from './constants.ts'
import { ChunkedHandle } from './chunked.ts'

vi.mock('./constants.ts', async (original) => ({
  ...(await original<typeof Constants>()),
  READ_CHUNK: 4,
}))

const ENC = new TextEncoder()
const DEC = new TextDecoder()

function handle(
  data = '0123456789',
  size = data.length,
): {
  file: ChunkedHandle
  fetched: [number, number][]
} {
  const bytes = ENC.encode(data)
  const fetched: [number, number][] = []
  const file = new ChunkedHandle('/f', size, (offset, length) => {
    fetched.push([offset, length])
    return Promise.resolve(bytes.slice(offset, offset + length))
  })
  return { file, fetched }
}

async function filled(file: ChunkedHandle, size: number | 'line'): Promise<void> {
  while (size === 'line' ? file.lacksLine() : file.lacks(size))
    await file.fill(size === 'line' ? 0 : size)
}

describe('ChunkedHandle', () => {
  it('answers small reads with one fetch per chunk', async () => {
    const { file, fetched } = handle()
    expect(fetched).toEqual([])
    expect(DEC.decode(await file.pread(0, 1))).toBe('0')
    expect(DEC.decode(await file.pread(1, 3))).toBe('123')
    expect(DEC.decode(await file.pread(2, 4))).toBe('2345')
    expect(fetched).toEqual([
      [0, 4],
      [4, 4],
    ])
  })

  it('ends where a fetch comes back short, not at the size the open saw', async () => {
    // A rendering need not be as long as the stored bytes a stat measured.
    for (const [data, size] of [
      ['0123456789', 6],
      ['01', 10],
    ] as const) {
      const { file } = handle(data, size)
      await filled(file, -1)
      expect(DEC.decode(file.read(null))).toBe(data)
      expect([file.size, file.eof]).toEqual([data.length, true])
    }
  })

  it('keeps the size when a read past the end finds nothing', async () => {
    // Nothing at 100 does not put the end there: a seek to the end, and a
    // write after it, stay at 3.
    const { file } = handle('abc')
    file.pos = 100
    await filled(file, 4)
    expect([file.read(4).length, file.size]).toEqual([0, 3])
  })

  it('fills a line that runs across two chunks', async () => {
    // A synchronous guest reads only what the kept bytes hold, so a line
    // crossing a chunk edge must be held whole before it is read.
    const { file } = handle('ab\ncdefgh\nij')
    const lines: string[] = []
    for (;;) {
      await filled(file, 'line')
      const line = file.readLine()
      if (line === null) break
      lines.push(DEC.decode(line))
    }
    expect(lines).toEqual(['ab', 'cdefgh', 'ij'])
  })

  it('reads a byte budget, and refetches after a drop', async () => {
    const { file, fetched } = handle()
    await filled(file, 3)
    expect(DEC.decode(file.read(3))).toBe('012')
    file.drop()
    expect(file.lacks(1)).toBe(true)
    await filled(file, 1)
    expect(DEC.decode(file.read(1))).toBe('3')
    expect(fetched).toEqual([
      [0, 4],
      [3, 4],
    ])
  })

  it('answers overlapping reads from their own fetches, and installs none a drop outran', async () => {
    // FUSE issues reads concurrently, and a write drops the chunk while a
    // fetch may still be out.
    const bytes = ENC.encode('0123456789')
    const pending: (() => void)[] = []
    const file = new ChunkedHandle(
      '/f',
      10,
      (offset, length) =>
        new Promise<Uint8Array>((resolve) => {
          pending.push(() => {
            resolve(bytes.slice(offset, offset + length))
          })
        }),
    )
    const first = file.pread(0, 2)
    const second = file.pread(6, 2)
    file.drop()
    for (const release of pending.reverse()) release()
    expect([DEC.decode(await first), DEC.decode(await second)]).toEqual(['01', '67'])
    expect(file.lacks(1)).toBe(true)
  })
})
