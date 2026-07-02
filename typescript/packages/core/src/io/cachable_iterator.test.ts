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

  it('drainBounded stops when the budget is exceeded', async () => {
    const ci = new CachableAsyncIterator(fromChunks([encode('aa'), encode('bb'), encode('cc')]))
    const [bytes, full] = await ci.drainBounded(3)
    expect(full).toBe(false)
    expect(new TextDecoder().decode(bytes)).toBe('aabb')
  })

  it('drainBounded reports fully_drained when under budget', async () => {
    const ci = new CachableAsyncIterator(fromChunks([encode('ab')]))
    const [bytes, full] = await ci.drainBounded(100)
    expect(full).toBe(true)
    expect(new TextDecoder().decode(bytes)).toBe('ab')
  })
})
