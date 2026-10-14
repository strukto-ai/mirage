import { expect, it } from 'vitest'
import { ensureStream } from '../../../io/stream.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import { concat } from '../../../utils/bytes.ts'
import { encodeBase64 } from '../../../utils/base64.ts'
import { base64Generic } from './base64_cmd.ts'
import type { CommandOpts } from '../../config.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
function unused(): never {
  throw new Error('no file operand')
}

async function run(stdin: ByteSource, flags: CommandOpts['flags'] = {}) {
  const result = await base64Generic([], { stdin, flags, cwd: '/' }, unused, unused)
  if (result === null) throw new Error('base64 returned no result')
  return result
}

it.each([
  [false, 'abc', 'YWJj'],
  [true, 'YWJj', 'abc'],
] as const)('emits before the tail and closes (decode=%s)', async (decode, data, expected) => {
  let closed = false
  async function* source() {
    await Promise.resolve()
    try {
      yield ENC.encode(data)
      throw new Error('base64 fetched the tail')
    } finally {
      closed = true
    }
  }
  const [out] = await run(source(), { decode })
  const output = ensureStream(out ?? new Uint8Array())[Symbol.asyncIterator]()
  try {
    const first = await output.next()
    if (first.done === true) throw new Error('stream ended before its first output')
    expect(DEC.decode(first.value)).toBe(expected)
  } finally {
    await output.return?.()
  }
  expect(closed).toBe(true)
})

it.each([1, 2, 7, 16385])(
  'encoding carries bytes and wrap columns across chunks of %s',
  async (size) => {
    const data = Uint8Array.from({ length: 256 * 65 + 1 }, (_, i) =>
      i === 256 * 65 ? 120 : i % 256,
    )
    for (const wrap of [0, 1, 4, 76]) {
      async function* source() {
        await Promise.resolve()
        for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
      }
      const [out] = await run(source(), { wrap: String(wrap) })
      const parts: Uint8Array[] = []
      for await (const part of ensureStream(out ?? new Uint8Array())) parts.push(part)
      const encoded = encodeBase64(data)
      const expected =
        wrap === 0
          ? encoded
          : (encoded.match(new RegExp(`.{1,${String(wrap)}}`, 'g')) ?? []).join('\n') + '\n'
      expect(DEC.decode(concat(parts))).toBe(expected)
      expect(Math.max(...parts.map((part) => part.length))).toBeLessThanOrEqual(
        2 * 4 * (Math.floor(16384 / 3) + 1),
      )
    }
  },
)

it.each<[string, boolean, string, number]>([
  ['YQ==Yg==', false, 'ab', 0],
  ['YQ=\n=', false, 'a', 0],
  ['YQ', false, 'a', 0],
  ['YWI', false, 'ab', 0],
  ['YQ=', false, 'a', 1],
  ['YWJj!ZA==', false, 'abc', 1],
  ['YW Jj', false, 'a', 1],
  ['YQ===', false, 'a', 1],
  ['Y', false, '', 1],
  ['YR', false, 'a', 1],
  ['YWF=Yg==', false, 'aa', 1],
  ['Y!W Jj\u00ff', true, 'abc', 0],
])(
  'decoding padding and failures are chunk-independent %j',
  async (text, ignore, expected, code) => {
    const data = Uint8Array.from(text, (c) => c.charCodeAt(0))
    for (const size of [1, 3, 100]) {
      async function* source() {
        await Promise.resolve()
        for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size)
      }
      const flags: CommandOpts['flags'] = { decode: true, ignore_garbage: ignore }
      const [out, io] = await run(source(), flags)
      expect(DEC.decode(await materialize(out))).toBe(expected)
      expect(io.exitCode).toBe(code)
      expect(DEC.decode(await materialize(io.stderr))).toBe(code ? 'base64: invalid input\n' : '')
    }
  },
)

it.each([
  ['', ''],
  ['a', 'YQ==\n'],
  ['ab', 'YWI=\n'],
  ['abc', 'YWJj\n'],
  ['abcd', 'YWJjZA==\n'],
])('encoding flushes the final partial group %j', async (data, expected) => {
  const [out] = await run(ENC.encode(data))
  expect(DEC.decode(await materialize(out))).toBe(expected)
})

it.each([1, 2, 7, 16385])('decoding all byte values in bounded chunks of %s', async (size) => {
  const data = Uint8Array.from({ length: 256 * 65 }, (_, i) => i % 256)
  const encoded = ENC.encode(encodeBase64(data))
  async function* source() {
    await Promise.resolve()
    for (let at = 0; at < encoded.length; at += size) yield encoded.subarray(at, at + size)
  }
  const [out, io] = await run(source(), { decode: true })
  const parts: Uint8Array[] = []
  for await (const part of ensureStream(out ?? new Uint8Array())) parts.push(part)
  expect(concat(parts)).toEqual(data)
  expect(Math.max(...parts.map((part) => part.length))).toBeLessThanOrEqual(16384)
  expect(io.exitCode).toBe(0)
})
