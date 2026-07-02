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
import { AsyncLineIterator } from './async_line_iterator.ts'

async function* fromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const c of chunks) yield c
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('AsyncLineIterator', () => {
  it('splits chunks on newline', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('foo\nbar\nbaz\n')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['foo', 'bar', 'baz'])
  })

  it('reassembles lines across chunk boundaries', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('fo'), encode('o\nba'), encode('r\n')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['foo', 'bar'])
  })

  it('returns trailing unterminated data as the last line', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('foo\nbar')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['foo', 'bar'])
  })

  it('readline returns null at EOF', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('only\n')]))
    const first = await it.readline()
    if (first === null) throw new Error('expected line')
    expect(decode(first)).toBe('only')
    expect(await it.readline()).toBeNull()
  })

  it('handles empty source', async () => {
    const it = new AsyncLineIterator(fromChunks([]))
    expect(await it.readline()).toBeNull()
  })

  it('preserves empty lines', async () => {
    const it = new AsyncLineIterator(fromChunks([encode('a\n\nb\n')]))
    const lines: string[] = []
    for await (const line of it) lines.push(decode(line))
    expect(lines).toEqual(['a', '', 'b'])
  })
})
