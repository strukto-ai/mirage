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
import { CachableAsyncIterator } from './cachable_iterator.ts'
import {
  asyncChain,
  closeQuietly,
  drain,
  exitOnEmpty,
  mergeStdoutStderr,
  quietMatch,
  wrapCachableStreams,
  yieldBytes,
} from './stream.ts'
import { IOResult } from './types.ts'

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

describe('mergeStdoutStderr', () => {
  it('yields stderr before stdout and clears io.stderr', async () => {
    const io = new IOResult({ stderr: encode('err:') })
    const stream = fromChunks([encode('out1'), encode('out2')])
    expect(await collect(mergeStdoutStderr(stream, io))).toBe('err:out1out2')
    expect(io.stderr).toBeNull()
  })

  it('handles bytes stdout', async () => {
    const io = new IOResult()
    expect(await collect(mergeStdoutStderr(encode('data'), io))).toBe('data')
  })

  it('null stdout yields nothing extra', async () => {
    const io = new IOResult({ stderr: encode('e') })
    expect(await collect(mergeStdoutStderr(null, io))).toBe('e')
  })
})

describe('wrapCachableStreams', () => {
  it('wraps listed cache paths in CachableAsyncIterator', () => {
    const raw = fromChunks([encode('x')])
    const io = new IOResult({ reads: { '/a': raw }, cache: ['/a'] })
    const [, out] = wrapCachableStreams(null, io)
    expect(out.reads['/a']).toBeInstanceOf(CachableAsyncIterator)
  })

  it('rewires stdout when it aliased the wrapped read', () => {
    const raw = fromChunks([encode('x')])
    const io = new IOResult({ reads: { '/a': raw }, cache: ['/a'] })
    const [newStdout] = wrapCachableStreams(raw, io)
    expect(newStdout).toBeInstanceOf(CachableAsyncIterator)
  })

  it('leaves bytes alone', () => {
    const bytes = encode('x')
    const io = new IOResult({ reads: { '/a': bytes }, cache: ['/a'] })
    const [, out] = wrapCachableStreams(null, io)
    expect(out.reads['/a']).toBe(bytes)
  })
})

describe('exitOnEmpty', () => {
  it('passes chunks through unchanged', async () => {
    const io = new IOResult()
    const out = await collect(exitOnEmpty(fromChunks([encode('a')]), io))
    expect(out).toBe('a')
    expect(io.exitCode).toBe(0)
  })

  it('sets exit_code=1 on empty stream', async () => {
    const io = new IOResult()
    await collect(exitOnEmpty(fromChunks([]), io))
    expect(io.exitCode).toBe(1)
  })
})

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
})

describe('asyncChain', () => {
  it('chains multiple streams/bytes/null into one', async () => {
    const out = await collect(
      asyncChain(encode('a'), fromChunks([encode('b'), encode('c')]), null, encode('d')),
    )
    expect(out).toBe('abcd')
  })
})

describe('yieldBytes', () => {
  it('yields one chunk and stops', async () => {
    expect(await collect(yieldBytes(encode('once')))).toBe('once')
  })
})

describe('quietMatch', () => {
  it('sets exit_code=0 when stream has any chunk', async () => {
    const io = new IOResult()
    await collect(quietMatch(fromChunks([encode('a')]), io))
    expect(io.exitCode).toBe(0)
  })

  it('sets exit_code=1 when stream empty', async () => {
    const io = new IOResult()
    await collect(quietMatch(fromChunks([]), io))
    expect(io.exitCode).toBe(1)
  })
})
