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
// Mirrors python/tests/utils/test_compress.py.

import { describe, expect, it, vi } from 'vitest'
import { materialize } from '../io/types.ts'
import { yieldBytes } from '../io/stream.ts'
import {
  GZIP_CHUNK_SIZE,
  crc32,
  gunzipStream,
  gunzipChecked,
  gunzipPartial,
  gzip,
} from './compress.ts'
import { GzipDataError } from './errors.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
// gzip -n of "hello\n": a fixed ten-byte header, the deflate body, trailer.
const HELLO = new Uint8Array([
  0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0xe7, 2, 0, 0x20, 0x30, 0x3a,
  0x36, 6, 0, 0, 0,
])
const HCRC_HEAD = new Uint8Array([...HELLO.subarray(0, 3), 2, ...HELLO.subarray(4, 10)])

function cat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(parts.flatMap((p) => [...p]))
}

function render(err: unknown): string {
  if (!(err instanceof GzipDataError)) throw err
  return err.render('gzip', 'f')
}

describe('gunzipChecked', () => {
  it('decompresses every member', async () => {
    const hello = await gzip(ENC.encode('hello\n'))
    const both = new Uint8Array([...hello, ...hello])
    expect(DEC.decode(await gunzipChecked(both))).toBe('hello\nhello\n')
  })

  // gzip 1.13: no header, or a header gzip does not support, is reported and
  // skipped, while a short, truncated or corrupt input ends the run.
  it.each([
    ['empty', new Uint8Array(0), 'gzip: f: unexpected end of file\n', true],
    ['one byte', ENC.encode('x'), 'gzip: f: unexpected end of file\n', true],
    ['plain', ENC.encode('hello\n'), 'gzip: f: not in gzip format\n', false],
    ['a bare header', HELLO.subarray(0, 10), 'gzip: f: unexpected end of file\n', true],
    [
      'a cut trailer',
      HELLO.subarray(0, HELLO.length - 3),
      'gzip: f: unexpected end of file\n',
      true,
    ],
    [
      'corrupt',
      new Uint8Array([0x1f, 0x8b, 8, 0, ...ENC.encode('garbage-here')]),
      'gzip: f: invalid compressed data--format violated\n',
      true,
    ],
    [
      'method 7',
      new Uint8Array([0x1f, 0x8b, 7]),
      'gzip: f: unknown method 7 -- not supported\n',
      false,
    ],
    [
      'encrypted',
      new Uint8Array([0x1f, 0x8b, 8, 0x20]),
      'gzip: f is encrypted -- not supported\n',
      false,
    ],
    [
      'reserved flags',
      new Uint8Array([0x1f, 0x8b, 8, 0x48]),
      'gzip: f has flags 0x48 -- not supported\n',
      false,
    ],
    [
      'a bad header checksum',
      cat(HCRC_HEAD, new Uint8Array(2), HELLO.subarray(10)),
      `gzip: f: header checksum 0x0000 != computed checksum 0x${(crc32(HCRC_HEAD) & 0xffff).toString(16).padStart(4, '0')}\n`,
      false,
    ],
  ] as const)('refuses %s with gzip reason and severity', async (_name, data, reason, fatal) => {
    const err: unknown = await gunzipChecked(data).catch((e: unknown) => e)
    expect(render(err)).toBe(reason)
    expect(err).toMatchObject({ fatal })
  })

  it('skips the optional header fields', async () => {
    const head = cat(HELLO.subarray(0, 3), new Uint8Array([0x1e]), HELLO.subarray(4, 10))
    const fields = cat(head, new Uint8Array([3, 0]), ENC.encode('abc'))
    const named = cat(fields, ENC.encode('name\0comment\0'))
    const crc = crc32(named) & 0xffff
    const data = cat(named, new Uint8Array([crc & 0xff, crc >> 8]), HELLO.subarray(10))
    expect(DEC.decode(await gunzipChecked(data))).toBe('hello\n')
  })

  it.each([
    [
      'both',
      new Uint8Array(8),
      ['{}: invalid compressed data--crc error', '{}: invalid compressed data--length error'],
    ],
    [
      'the CRC',
      cat(new Uint8Array(4), HELLO.subarray(-4)),
      ['{}: invalid compressed data--crc error'],
    ],
    [
      'the length',
      cat(HELLO.subarray(-8, -4), new Uint8Array(4)),
      ['{}: invalid compressed data--length error'],
    ],
  ] as const)('names %s after the inflated bytes', async (_name, trailer, reasons) => {
    // gzip 1.13 writes what it inflated, then names each mismatch.
    const data = cat(HELLO.subarray(0, -8), trailer, HELLO)
    const decoded = gunzipStream(yieldBytes(data))[Symbol.asyncIterator]()
    expect((await decoded.next()).value).toEqual(ENC.encode('hello\n'))
    await expect(decoded.next()).rejects.toMatchObject({ reasons, fatal: true })
  })

  it('only skips the input on a trailer mismatch under test', async () => {
    const data = cat(HELLO.subarray(0, -8), new Uint8Array(8))
    await expect(materialize(gunzipStream(yieldBytes(data), true))).rejects.toMatchObject({
      fatal: false,
    })
  })

  it.each([
    ['trailing garbage', cat(HELLO, ENC.encode('junk')), 'hello\n', true],
    ['a zeroed trailer', cat(HELLO.subarray(0, -8), new Uint8Array(8)), 'hello\n', true],
    ['a cut trailer', cat(HELLO, HELLO.subarray(0, -3)), 'hello\nhello\n', true],
  ] as const)('keeps what gzip wrote before %s', async (_name, data, decoded, keeps) => {
    const [out, failure] = await gunzipPartial(data)
    expect([DEC.decode(out), failure?.keepsOutput]).toEqual([decoded, keeps])
    const [whole, none] = await gunzipPartial(HELLO)
    expect([DEC.decode(whole), none]).toEqual(['hello\n', null])
  })

  it.each([
    ['a first member', cat(HELLO.subarray(0, 2), new Uint8Array([7]), HELLO.subarray(3)), false],
    ['a second member', cat(HELLO, HELLO.subarray(0, 2), new Uint8Array([7])), true],
    ['trailing garbage', cat(HELLO, ENC.encode('junk')), true],
  ] as const)('keeps the members before a refusal of %s: %s', async (_name, data, keeps) => {
    await expect(gunzipChecked(data)).rejects.toMatchObject({ fatal: false, keepsOutput: keeps })
  })
})

describe('gunzipStream', () => {
  it.each([1, 7, 65536])(
    'handles member boundaries and padding at chunk width %i',
    async (width) => {
      const hello = await gzip(ENC.encode('hello\n'))
      const data = new Uint8Array([...hello, ...hello, 0, 0])
      async function* source(): AsyncIterable<Uint8Array> {
        for (let offset = 0; offset < data.length; offset += width)
          yield* yieldBytes(data.subarray(offset, offset + width))
      }
      expect(DEC.decode(await materialize(gunzipStream(source())))).toBe('hello\nhello\n')
    },
  )

  it('yields bounded expansion before reading more input', async () => {
    const archive = await gzip(ENC.encode('x'.repeat(GZIP_CHUNK_SIZE * 20)))
    const reads: number[] = []
    async function* source(): AsyncIterable<Uint8Array> {
      reads.push(1)
      yield* yieldBytes(archive)
      reads.push(2)
      yield* yieldBytes(archive)
    }
    const decoded = gunzipStream(source())[Symbol.asyncIterator]()
    expect((await decoded.next()).value).toEqual(ENC.encode('x'.repeat(GZIP_CHUNK_SIZE)))
    expect(reads).toEqual([1])
    await decoded.return?.()
    expect(reads).toEqual([1])
  })

  it('reports trailing garbage after yielding valid output', async () => {
    const archive = await gzip(ENC.encode('hello\n'))
    const decoded = gunzipStream(yieldBytes(new Uint8Array([...archive, ...ENC.encode('junk')])))[
      Symbol.asyncIterator
    ]()
    expect((await decoded.next()).value).toEqual(ENC.encode('hello\n'))
    await expect(decoded.next()).rejects.toMatchObject({ exitCode: 2, fatal: false })
  })
})

it('preserves buffered output in a large member', async () => {
  const text = 'x'.repeat(GZIP_CHUNK_SIZE * 20 + 13)
  expect(DEC.decode(await gunzipChecked(await gzip(ENC.encode(text))))).toBe(text)
})

it.each([1, 7, 65536])(
  'distinguishes complete bodies at EOF with chunk width %i',
  async (width) => {
    for (const [data, keepsOutput] of [
      [HELLO.subarray(0, -8), true],
      [HELLO.subarray(0, -3), true],
      [cat(HELLO, HELLO.subarray(0, 2)), true],
      [HELLO.subarray(0, 2), false],
      [cat(HELLO, HELLO.subarray(0, 10)), false],
      [HELLO.subarray(0, -9), false],
    ] as const) {
      async function* source(): AsyncIterable<Uint8Array> {
        for (let offset = 0; offset < data.length; offset += width)
          yield* yieldBytes(data.subarray(offset, offset + width))
      }
      await expect(materialize(gunzipStream(source()))).rejects.toMatchObject({
        fatal: true,
        keepsOutput,
      })
    }
  },
)

it.each([1, 7, 65536])('reads optional fields and header CRC at width %i', async (width) => {
  for (const fields of [
    new Uint8Array(4),
    cat(new Uint8Array([3, 0]), ENC.encode('abcname\0comment\0')),
  ]) {
    const head = cat(HELLO.subarray(0, 3), new Uint8Array([0x1e]), HELLO.subarray(4, 10), fields)
    const crc = crc32(head) & 0xffff
    const member = cat(head, new Uint8Array([crc & 0xff, crc >> 8]), HELLO.subarray(10))
    const data = cat(member, member)
    async function* source(): AsyncIterable<Uint8Array> {
      for (let offset = 0; offset < data.length; offset += width)
        yield* yieldBytes(data.subarray(offset, offset + width))
    }
    expect(DEC.decode(await materialize(gunzipStream(source())))).toBe('hello\nhello\n')
  }
})

it.each([0x04, 0x08, 0x10, 0x02])('rejects EOF in consumed optional field %i', async (flag) => {
  for (const prefix of [new Uint8Array(), HELLO]) {
    const head = cat(HELLO.subarray(0, 3), new Uint8Array([flag]), HELLO.subarray(4, 10))
    const extra = flag === 0x04 ? new Uint8Array([255, 255, 97, 98, 99]) : new Uint8Array()
    await expect(gunzipChecked(cat(prefix, head, extra))).rejects.toMatchObject({
      fatal: true,
      keepsOutput: prefix.length > 0,
    })
  }
})

it.each([0x08, 0x10])('consumes long header field %i without growing copies', async (flag) => {
  for (const terminated of [false, true]) {
    const head = cat(HELLO.subarray(0, 3), new Uint8Array([flag | 0x02]), HELLO.subarray(4, 10))
    const chunk = new Uint8Array(GZIP_CHUNK_SIZE).fill(120)
    const copies = vi.spyOn(Uint8Array.prototype, 'slice')
    async function* source(): AsyncIterable<Uint8Array> {
      yield* yieldBytes(head)
      let crc = crc32(head)
      for (let i = 0; i < 128; i++) {
        yield* yieldBytes(chunk)
        crc = crc32(chunk, crc)
      }
      if (terminated) {
        crc = crc32(new Uint8Array(1), crc) & 0xffff
        yield* yieldBytes(cat(new Uint8Array([0, crc & 0xff, crc >> 8]), HELLO.subarray(10)))
      }
    }
    try {
      const decoded = materialize(gunzipStream(source()))
      if (terminated) expect(DEC.decode(await decoded)).toBe('hello\n')
      else
        await expect(decoded).rejects.toMatchObject({
          fatal: true,
          reasons: ['{}: unexpected end of file'],
        })
      expect(copies.mock.contexts.every((bytes) => bytes.byteLength <= GZIP_CHUNK_SIZE)).toBe(true)
    } finally {
      copies.mockRestore()
    }
  }
})
