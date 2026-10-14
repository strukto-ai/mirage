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
import { parseLimit, parseSeek, strtol, xxdGeneric } from './xxd.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const DATA = ENC.encode('defgh')
const F = new PathSpec({ virtual: '/f', directory: '/', vfsPath: 'f', rawPath: '/f' })

function opts(flags: Record<string, unknown>, stdin: Uint8Array | null = null): CommandOpts {
  return { flags, stdin } as unknown as CommandOpts
}

describe('xxd numbers', () => {
  // Mirrors python's test_strtol_reads_base_zero_and_drops_the_rest.
  it.each([
    ['2', 2],
    ['0x2', 2],
    ['017', 15],
    ['2k', 2],
    ['x', 0],
    ['08', 0],
    ['-3', -3],
  ])('strtol %j', (raw, value) => {
    expect(strtol(raw)).toBe(value)
  })

  // Mirrors python's test_parse_seek_reads_the_signs.
  it.each([
    ['2', { offset: 2, relative: false, back: false }],
    ['+2', { offset: 2, relative: true, back: false }],
    ['-2', { offset: 2, relative: false, back: true }],
    ['+-2', { offset: 2, relative: true, back: true }],
  ])('parseSeek %j', (raw, seek) => {
    expect(parseSeek(raw)).toEqual(seek)
  })
})

describe('xxd -s', () => {
  const io = (read: string[]) =>
    [
      async function* (): AsyncIterable<Uint8Array> {
        read.push('stream')
        await Promise.resolve()
        yield DATA
      },
      (_p: PathSpec, offset: number, size: number | null): Promise<Uint8Array> => {
        read.push(`${String(offset)}+${String(size)}`)
        return Promise.resolve(DATA.subarray(offset, size === null ? undefined : offset + size))
      },
      (): Promise<number | null> => Promise.resolve(DATA.byteLength),
    ] as const

  // Mirrors python's test_a_dump_seeks_with_one_ranged_read.
  it.each([
    ['2', undefined, '00000002: 6667 68                                  fgh\n', ['2+3']],
    ['-2', '1', '00000003: 67                                       g\n', ['3+1']],
    ['10', undefined, '', []],
    ['1', '0', '', []],
    ['0', undefined, '00000000: 6465 6667 68                             defgh\n', ['stream']],
  ])('-s %s -l %s', async (seek, limit, out, reads) => {
    const read: string[] = []
    const [stream, readRange, sizeOf] = io(read)
    const flags = limit === undefined ? { s: seek } : { s: seek, args_l: limit }
    const [stdout, result] = await xxdGeneric(
      [F],
      opts(flags),
      stream,
      null,
      null,
      null,
      readRange,
      sizeOf,
    )
    expect(DEC.decode(await materialize(stdout))).toBe(out)
    expect(result.exitCode).toBe(0)
    expect(read).toEqual(reads)
  })

  // Mirrors python's test_a_seek_before_the_start_cannot_seek.
  it.each(['-10', '+-2'])('-s %s cannot seek', async (seek) => {
    const [stream, readRange, sizeOf] = io([])
    const [stdout, result] = await xxdGeneric(
      [F],
      opts({ s: seek }),
      stream,
      null,
      null,
      null,
      readRange,
      sizeOf,
    )
    expect([stdout, result.exitCode, DEC.decode(await materialize(result.stderr))]).toEqual([
      null,
      4,
      'xxd: Sorry, cannot seek.\n',
    ])
  })

  // Mirrors python's test_stdin_is_read_off_and_cannot_seek_back.
  it.each([
    ['2', 0, '00000002: 6667 68                                  fgh\n'],
    ['-2', 4, ''],
    ['10', 4, ''],
  ])('stdin -s %s', async (seek, code, out) => {
    const empty = async function* (): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield new Uint8Array()
    }
    const [stdout, result] = await xxdGeneric([], opts({ s: seek }, DATA), empty)
    expect([DEC.decode(await materialize(stdout)), result.exitCode]).toEqual([out, code])
  })
})

describe('xxd -l', () => {
  // Mirrors python's test_parse_limit_reads_no_limit_for_a_negative_count.
  it.each([
    [undefined, null],
    ['2', 2],
    ['0', 0],
    ['x', 0],
    ['-1', null],
  ])('parseLimit %j', (raw, limit) => {
    expect(parseLimit(raw)).toBe(limit)
  })

  // Mirrors python's test_a_seek_without_a_limit_reads_growing_blocks.
  it('reads a seek without a limit in growing blocks', async () => {
    const data = new Uint8Array(256 * 1024).map((_, i) => i % 256)
    const asked: [number, number | null][] = []
    const stream = (): AsyncIterable<Uint8Array> => {
      throw new Error('streamed')
    }
    const readRange = (_p: PathSpec, offset: number, size: number | null): Promise<Uint8Array> => {
      asked.push([offset, size])
      return Promise.resolve(data.subarray(offset, size === null ? undefined : offset + size))
    }
    const [stdout] = await xxdGeneric(
      [F],
      opts({ s: '16' }),
      stream,
      null,
      null,
      null,
      readRange,
      () => Promise.resolve(data.byteLength),
    )
    const first = await (stdout as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]().next()
    expect(DEC.decode(first.done === true ? new Uint8Array() : first.value)).toMatch(
      /^00000010: 1011 1213/,
    )
    expect(asked).toEqual([[16, 64 * 1024]])
  })
})
