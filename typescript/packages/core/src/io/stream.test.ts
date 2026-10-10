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
import { SharedInput } from './async_line_iterator.ts'
import {
  SharedStdin,
  asyncChain,
  closeQuietly,
  discardStreams,
  drain,
  ensureStream,
  yieldBytes,
} from './stream.ts'

async function* fromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const c of chunks) yield c
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const out: string[] = []
  for await (const c of stream) out.push(new TextDecoder().decode(c))
  return out.join('')
}

describe('drain', () => {
  it('consumes all chunks from a stream', async () => {
    let count = 0
    async function* counting(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      yield encode('a')
      count++
      yield encode('b')
      count++
    }
    await drain(counting())
    expect(count).toBe(2)
  })

  it('is a no-op on bytes', async () => {
    await drain(encode('x'))
  })

  it('is a no-op on null', async () => {
    await drain(null)
  })
})

describe('closeQuietly', () => {
  it('calls return on an async generator', async () => {
    let closed = false
    async function* gen(): AsyncGenerator<Uint8Array, void, void> {
      try {
        await Promise.resolve()
        yield encode('a')
      } finally {
        closed = true
      }
    }
    const stream = gen()
    const first = await stream.next()
    expect(first.done).toBe(false)
    await closeQuietly(stream)
    expect(closed).toBe(true)
  })

  it('is a no-op on bytes', async () => {
    await closeQuietly(encode('x'))
  })

  it('leaves a shared input to a discard', async () => {
    let closed = false
    async function* gen(): AsyncGenerator<Uint8Array, void, void> {
      try {
        await Promise.resolve()
        yield encode('a\n')
        yield encode('b\n')
        yield encode('c\n')
      } finally {
        closed = true
      }
    }
    const shared = new SharedInput(gen())
    const text = async (): Promise<string | null> => {
      const line = await shared.lines.readline()
      return line === null ? null : new TextDecoder().decode(line)
    }
    expect(await text()).toBe('a')
    await closeQuietly(shared)
    expect(await text()).toBe('b')
    await discardStreams(shared)
    expect(closed).toBe(true)
    expect(await text()).toBeNull()
  })
})

describe('asyncChain', () => {
  it('chains multiple streams/bytes/null into one', async () => {
    const out = await collect(
      asyncChain([encode('a'), fromChunks([encode('b'), encode('c')]), null, encode('d')]),
    )
    expect(out).toBe('abcd')
  })
})

describe('yieldBytes', () => {
  it('yields one chunk and stops', async () => {
    expect(await collect(yieldBytes(encode('once')))).toBe('once')
  })
})

describe('ensureStream', () => {
  it('wraps bytes and passes a stream through', async () => {
    expect(await collect(ensureStream(encode('hello')))).toBe('hello')
    const source = fromChunks([encode('foo'), encode('bar')])
    expect(ensureStream(source)).toBe(source)
  })
})

it('shares a lazy cursor across early exit and concurrent readers', async () => {
  const pulls: string[] = []
  async function* source() {
    for (const chunk of ['', 'abc', '', 'def']) {
      await Promise.resolve()
      pulls.push(chunk)
      yield new TextEncoder().encode(chunk)
    }
  }
  const shared = new SharedStdin(source())
  expect(pulls).toEqual([])
  for await (const byte of shared) {
    expect(new TextDecoder().decode(byte)).toBe('a')
    break
  }
  const other = shared[Symbol.asyncIterator]()
  const bytes = await Promise.all(Array.from({ length: 5 }, () => other.next()))
  expect(bytes.map((step) => new TextDecoder().decode(step.value)).join('')).toBe('bcdef')
  expect((await other.next()).done).toBe(true)
  expect((await shared[Symbol.asyncIterator]().next()).done).toBe(true)
  expect(pulls).toEqual(['', 'abc', '', 'def'])
})
