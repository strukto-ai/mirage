import { describe, expect, it } from 'vitest'

import { ensureStream } from '../../../io/stream.ts'
import { materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { Context } from '../../config.ts'
import { trGeneric } from './tr.ts'

function unusedRead(): never {
  throw new Error('input source must not be opened')
}

async function runTr(texts: string[], stdin: ByteSource, flags: Context['flags'] = {}) {
  const result = await trGeneric(
    [],
    texts,
    { stdin, flags, cwd: PathSpec.fromStrPath('/') },
    unusedRead,
  )
  const output = result?.[0]
  if (output === null || output === undefined) throw new Error('tr returned no output')
  return output
}

describe('tr byte stream', () => {
  it('translates and squeezes malformed bytes across every chunk split', async () => {
    const data = Uint8Array.of(0xff, 0xff, 0x80, 0x80, 0xc3, 0xa9)
    for (let split = 0; split <= data.byteLength; split++) {
      async function* source(): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        yield data.subarray(0, split)
        yield new Uint8Array()
        yield data.subarray(split)
      }
      const output = await runTr([String.raw`\377\200`, 'ab'], source(), {
        squeeze_repeats: true,
      })
      expect(await materialize(output)).toEqual(Uint8Array.of(0x61, 0x62, 0xc3, 0xa9))
    }
  })

  it('keeps the previous emitted byte across deleted-only chunks', async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      for (const text of ['aa', '___', '', 'aaa', '___', 'bbb']) {
        await Promise.resolve()
        yield new TextEncoder().encode(text)
      }
    }
    const output = await runTr(['_', 'ab'], source(), {
      delete: true,
      squeeze_repeats: true,
    })
    expect(new TextDecoder().decode(await materialize(output))).toBe('ab')
  })

  it.each([
    {
      texts: ['[:bogus:]'],
      flags: { delete: true },
      message: "tr: invalid character class 'bogus'\n",
    },
    {
      texts: ['a', 'z-a'],
      flags: { delete: false },
      message:
        "tr: missing operand after 'a'\n" +
        'Two strings must be given when translating.\n' +
        "Try 'tr --help' for more information.\n",
    },
  ])('refuses operands before opening the source for $texts', async ({ texts, flags, message }) => {
    const result = await trGeneric(
      [PathSpec.fromStrPath('/input')],
      texts,
      { stdin: null, flags, cwd: PathSpec.fromStrPath('/') },
      unusedRead,
    )
    if (result === null) throw new Error('tr returned no refusal')
    expect(result[0]).toBeNull()
    expect(result[1].exitCode).toBe(1)
    expect(new TextDecoder().decode(await materialize(result[1].stderr))).toBe(message)
  })

  it('yields bounded output for a large input chunk', async () => {
    const data = new Uint8Array(64 * 1024 + 1).fill(0x78)
    const output = await runTr(['a', 'b'], data)
    let length = 0
    for await (const part of ensureStream(output)) {
      expect(part.byteLength).toBeLessThanOrEqual(16 * 1024)
      expect(part.every((byte) => byte === 0x78)).toBe(true)
      length += part.byteLength
    }
    expect(length).toBe(data.byteLength)
  })

  it('closes an early consumer without reading ahead', async () => {
    let closed = 0
    async function* source(): AsyncIterable<Uint8Array> {
      try {
        await Promise.resolve()
        yield Uint8Array.of(0x61, 0x61, 0x61)
        throw new Error('input was read beyond the first output')
      } finally {
        closed += 1
      }
    }
    const output = await runTr(['a', 'b'], source())
    const iterator = ensureStream(output)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual(Uint8Array.of(0x62, 0x62, 0x62))
    await iterator.return?.()
    expect(closed).toBe(1)
  })

  it('cancels a ready empty source and closes it', async () => {
    let closed = false
    async function* source(): AsyncIterable<Uint8Array> {
      try {
        for (let index = 0; index < 2_000_000; index++) {
          await Promise.resolve()
          yield new Uint8Array()
        }
      } finally {
        closed = true
      }
    }
    const abort = new AbortController()
    const result = await trGeneric(
      [],
      ['a', 'b'],
      { stdin: source(), flags: {}, cwd: PathSpec.fromStrPath('/'), signal: abort.signal },
      unusedRead,
    )
    if (result === null) throw new Error('tr returned no result')
    const timer = setTimeout(() => {
      abort.abort()
    }, 5)
    try {
      await expect(materialize(result[0])).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      clearTimeout(timer)
    }
    expect(closed).toBe(true)
  })
})
