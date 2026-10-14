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

import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { tacGeneric } from './tac.ts'

const ENC = new TextEncoder()
const BIG = PathSpec.fromStrPath('/big')

function streamOf(data: Uint8Array): (p: PathSpec) => AsyncIterable<Uint8Array> {
  return async function* () {
    await Promise.resolve()
    yield data
  }
}

function ranged(
  data: Uint8Array,
  asked: [number, number | null][],
): (p: PathSpec, offset: number, size: number | null) => Promise<Uint8Array> {
  return (_p, offset, size) => {
    asked.push([offset, size])
    return Promise.resolve(data.subarray(offset, size === null ? undefined : offset + size))
  }
}

function opts(flags: Record<string, unknown>, stdin: Uint8Array | null = null): CommandOpts {
  return { flags, stdin } as unknown as CommandOpts
}

describe('tac read from the end', () => {
  // Mirrors python's test_a_ranged_tac_gives_what_a_whole_read_gives.
  const lines = Array.from({ length: 40000 }, (_, n) => `line ${String(n)}\n`).join('')
  it.each([
    ['a\nb\nc\n'],
    ['a\nb\nc'],
    ['\n\nx\n'],
    [lines],
    ['x'.repeat(100000) + '\n' + 'y'.repeat(70000)],
  ])('gives what a whole read gives: %#', async (text) => {
    const data = ENC.encode(text)
    for (const before of [false, true]) {
      const flags = before ? { before: true } : {}
      const [whole] = await tacGeneric([BIG], opts(flags), streamOf(data))
      const [fromEnd] = await tacGeneric(
        [BIG],
        opts(flags),
        streamOf(new Uint8Array()),
        ranged(data, []),
        () => Promise.resolve(data.byteLength),
      )
      expect(await materialize(fromEnd)).toEqual(await materialize(whole))
    }
  })

  // Mirrors python's test_a_ranged_tac_reads_only_the_end_a_reader_pulls.
  it('reads only the end a reader pulls', async () => {
    const data = ENC.encode(
      Array.from({ length: 400000 }, (_, n) => `line ${String(n)}\n`).join(''),
    )
    const asked: [number, number | null][] = []
    const [out] = await tacGeneric(
      [BIG],
      opts({}),
      streamOf(new Uint8Array()),
      ranged(data, asked),
      () => Promise.resolve(data.byteLength),
    )
    const iterator = (out as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const first = await iterator.next()
    const head = first.done === true ? new Uint8Array() : first.value
    expect(new TextDecoder().decode(head).startsWith('line 399999\nline 399998\n')).toBe(true)
    expect(asked).toEqual([[data.byteLength - 64 * 1024, 64 * 1024]])
  })
})

describe('tac records', () => {
  // Mirrors python's test_tac_keeps_bytes_and_puts_b_before_the_record.
  it.each([
    [ENC.encode('a|b|c|'), true, ENC.encode('||c|ba')],
    [ENC.encode('a|b|c|'), false, ENC.encode('c|b|a|')],
    [
      Uint8Array.of(0xff, 0xfe, 0x7c, 0x80, 0x7c),
      false,
      Uint8Array.of(0x80, 0x7c, 0xff, 0xfe, 0x7c),
    ],
  ])('%#', async (data, before, expected) => {
    const flags = before ? { before: true, separator: '|' } : { separator: '|' }
    const [out] = await tacGeneric([], opts(flags, data), streamOf(new Uint8Array()))
    expect(await materialize(out)).toEqual(expected)
  })
})
