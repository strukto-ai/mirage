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
import { eisdir, enoent } from '../../../errors/fs.ts'
import { asyncChain } from '../../../io/stream.ts'
import { PathSpec } from '../../../types.ts'
import { RandomSource, RandomSourceError } from './random_source.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const SOURCE = PathSpec.fromStrPath('/r')

function reader(data: string, size = 3): (p: PathSpec) => AsyncIterable<Uint8Array> {
  const bytes = ENC.encode(data)
  const pieces: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size))
  return () => asyncChain(pieces)
}

function failing(err: Error): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }) })
}

describe('RandomSource', () => {
  it('hands out bytes in order across chunks', async () => {
    const source = new RandomSource('shuf', SOURCE, reader('abcdefgh'))
    expect(DEC.decode(await source.take(2))).toBe('ab')
    expect(DEC.decode(await source.take(4))).toBe('cdef')
    expect(DEC.decode(await source.take(2))).toBe('gh')
    await source.close()
  })

  it('never opens a source nothing draws from', async () => {
    const opened: PathSpec[] = []
    const stream = (p: PathSpec): AsyncIterable<Uint8Array> => {
      opened.push(p)
      return reader('')(p)
    }
    await new RandomSource('shuf', SOURCE, stream).close()
    expect(opened).toEqual([])
  })

  it.each([
    [reader('ab'), null, "sort: '/r': end of file"],
    [failing(eisdir(SOURCE)), null, "shuf: '/r': read error: Is a directory"],
    [failing(enoent(SOURCE)), 'open failed', 'sort: open failed: /r: No such file or directory'],
    [failing(enoent(SOURCE)), null, 'shuf: /r: No such file or directory'],
  ])('refuses a source that cannot hand out the bytes: %#', async (stream, opening, message) => {
    const cmd = message.slice(0, message.indexOf(':'))
    const source = new RandomSource(cmd, SOURCE, stream, opening)
    const refused = await source.take(4).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(RandomSourceError)
    expect((refused as RandomSourceError).message).toBe(message)
  })
})
