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
import { encodeBase64 } from '../utils/base64.ts'
import { StreamRefusal } from './errors.ts'
import { openStream, streamOutput } from './stream.ts'
import { discardStreams } from '../io/stream.ts'
import { materialize } from '../io/types.ts'
import { trGeneric } from '../commands/builtin/generic/tr.ts'
import { cutGeneric } from '../commands/builtin/generic/cut.ts'
import { FileStat, FileType, PathSpec } from '../types.ts'

const DECODE = { mode: 'decode', ignore_garbage: false }

it('closes eager command handles even before their first output pull', async () => {
  const probe = await openStream('uniq', {})
  const native: unknown = Reflect.get(probe, 'exports')
  if (typeof native !== 'object' || native === null) throw new Error('missing native exports')
  const exports = native
  function count(): number {
    const method: unknown = Reflect.get(exports, 'mirage_rs_open_count')
    if (typeof method !== 'function') throw new Error('missing open count')
    const value: unknown = Reflect.apply(method, exports, [])
    if (typeof value !== 'number') throw new Error('invalid open count')
    return value
  }
  async function* read(): AsyncIterable<Uint8Array> {
    yield await Promise.resolve(new TextEncoder().encode('a,b\n'))
  }
  const cwd = PathSpec.fromStrPath('/')
  const before = count()
  try {
    for (let index = 0; index < 3; index++) {
      const tr = await trGeneric([], ['a', 'b'], { flags: {}, stdin: null, cwd }, read)
      if (tr === null) throw new Error('missing tr result')
      await discardStreams(tr[0])
      expect(count()).toBe(before)
      for (const paths of [[], [PathSpec.fromStrPath('/input')]]) {
        const cut = await cutGeneric(
          paths,
          { flags: { fields: '1' }, stdin: null, cwd },
          read,
          () => Promise.resolve(new FileStat({ name: 'input', type: FileType.FILE })),
        )
        if (cut === null) throw new Error('missing cut result')
        await discardStreams(cut[0])
        expect(count()).toBe(before)
      }
      const failure = new Error('read initialization failed')
      const cut = await cutGeneric(
        ['/first', '/failed'].map((path) => PathSpec.fromStrPath(path)),
        { flags: { fields: '1' }, stdin: null, cwd },
        (path) => {
          if (path.virtual === '/failed') throw failure
          return read()
        },
        () => Promise.resolve(new FileStat({ name: 'input', type: FileType.FILE })),
      )
      if (cut === null) throw new Error('missing cut result')
      await expect(materialize(cut[0])).rejects.toBe(failure)
      expect(count()).toBe(before)
    }
  } finally {
    probe.close()
  }
})

it('aborts while a producer is blocked on its next chunk', async () => {
  const controller = new AbortController()
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const reading = new Promise<void>((resolve) => {
    started = resolve
  })
  async function* source(): AsyncGenerator<Uint8Array> {
    started?.()
    await blocked
    yield new Uint8Array()
  }
  const engine = await openStream('uniq', {})
  const output = streamOutput(engine, source(), controller.signal)
  const pending = output.next()
  try {
    await reading
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    release?.()
    await discardStreams(output)
  }
})

describe('openStream', () => {
  it('refuses a bad config with no output', async () => {
    const refused: unknown = await openStream('base64', { mode: 'nope' }).catch(
      (err: unknown) => err,
    )
    expect(refused).toBeInstanceOf(StreamRefusal)
    expect((refused as StreamRefusal).message).toMatch(/^bad stream config/)
    expect((refused as StreamRefusal).output.byteLength).toBe(0)
  })

  it('keeps the earlier pieces when a chunk past the input window refuses', async () => {
    const data = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256)
    const input = new TextEncoder().encode(`${encodeBase64(data)}*`)
    const stream = await openStream('base64', DECODE)
    let refused: unknown
    try {
      stream.feed(input)
    } catch (err) {
      refused = err
    } finally {
      stream.close()
      stream.close()
    }
    expect(refused).toBeInstanceOf(StreamRefusal)
    expect((refused as StreamRefusal).output).toEqual(data)
  })

  it('reads one input after another', async () => {
    const stream = await openStream('grep', { patterns: ['*a'], syntax: 'extended', count: true })
    const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
    try {
      expect(text(stream.takeStderr())).toBe('grep: warning: * at start of expression\n')
      for (const [data, count, status] of [
        ['a\nb\n', '1\n', 0],
        ['b\n', '0\n', 1],
      ] as const) {
        stream.begin({ label: 'in' })
        expect(stream.feed(new TextEncoder().encode(data)).byteLength).toBe(0)
        expect(stream.done()).toBe(false)
        expect(text(stream.finish())).toBe(count)
        expect(stream.status()).toBe(status)
      }
    } finally {
      stream.close()
    }
  })

  it('refuses another input for a stream of one', async () => {
    const stream = await openStream('base64', DECODE)
    try {
      expect(() => {
        stream.begin({})
      }).toThrow(StreamRefusal)
    } finally {
      stream.close()
    }
  })
})
