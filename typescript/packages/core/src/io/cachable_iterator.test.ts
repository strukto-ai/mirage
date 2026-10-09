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
import { CachableAsyncIterator, concat } from './cachable_iterator.ts'

async function* fromChunks(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const c of chunks) yield c
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('CachableAsyncIterator', () => {
  it('passes chunks through when iterated', async () => {
    const ci = new CachableAsyncIterator(fromChunks([encode('a'), encode('b')]))
    const out: string[] = []
    for await (const c of ci) out.push(new TextDecoder().decode(c))
    expect(out).toEqual(['a', 'b'])
    expect(ci.exhausted).toBe(true)
  })

  it('drain returns the full data even when never iterated', async () => {
    const ci = new CachableAsyncIterator(fromChunks([encode('hello '), encode('world')]))
    const drained = await ci.drain()
    expect(new TextDecoder().decode(drained)).toBe('hello world')
    expect(ci.exhausted).toBe(true)
  })

  it('drain accumulates with already-iterated chunks', async () => {
    const ci = new CachableAsyncIterator(fromChunks([encode('a'), encode('b'), encode('c')]))
    const first = await ci.next()
    expect(first.done).toBe(false)
    const drained = await ci.drain()
    expect(new TextDecoder().decode(drained)).toBe('abc')
  })
})

describe('discard behind a pull that never settles', () => {
  async function* stuck(): AsyncGenerator<Uint8Array> {
    await new Promise<never>(() => undefined)
    yield new Uint8Array(1)
  }

  it('does not wait for the return queued behind the pull', async () => {
    // The consumer raced the pull against its signal and was released;
    // the cleanup that follows must not be held by the same pull.
    const iterator = new CachableAsyncIterator(stuck())
    const pull = iterator.next()
    void pull.catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const outcome = await Promise.race([
      iterator.discard().then(() => 'released'),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('hung')
        }, 200)
      }),
    ])
    expect(outcome).toBe('released')
    expect(iterator.discarded).toBe(true)
  })

  it('still awaits the return when no pull is outstanding', async () => {
    let closed = false
    async function* closing(): AsyncGenerator<Uint8Array> {
      try {
        await Promise.resolve()
        yield new Uint8Array(1)
        yield new Uint8Array(1)
      } finally {
        closed = true
      }
    }
    const iterator = new CachableAsyncIterator(closing())
    await iterator.next()
    await iterator.discard()
    expect(closed).toBe(true)
  })
})

describe('concat', () => {
  it('concatenates byte arrays in order', () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([4, 5])
    expect(Array.from(concat([a, b]))).toEqual([1, 2, 3, 4, 5])
  })

  it('returns empty array for empty input', () => {
    expect(concat([])).toEqual(new Uint8Array(0))
  })
})
