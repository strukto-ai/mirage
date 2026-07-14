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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStream } from './stream.ts'
import { makeAccessor, notFoundResponse, routedFetch, spec } from './_test_util.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function bodyResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

async function collect(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const chunk of iter) out.push(chunk)
  return out
}

describe('readStream', () => {
  it('re-chunks the body at 8192 bytes', async () => {
    const big = new Uint8Array(8192 + 100).fill(7)
    const { fetch } = routedFetch(() => bodyResponse([big]))
    vi.stubGlobal('fetch', fetch)
    const chunks = await collect(readStream(makeAccessor(), spec('/volume/big.bin')))
    expect(chunks.map((c) => c.byteLength)).toEqual([8192, 100])
  })

  it('coalesces small network chunks', async () => {
    const { fetch } = routedFetch(() => bodyResponse([new Uint8Array([1, 2]), new Uint8Array([3])]))
    vi.stubGlobal('fetch', fetch)
    const chunks = await collect(readStream(makeAccessor(), spec('/volume/small.bin')))
    expect(chunks).toHaveLength(1)
    expect(Array.from(chunks[0] ?? [])).toEqual([1, 2, 3])
  })

  it('cancels the response body when the consumer stops early', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8192).fill(7))
      },
      cancel() {
        cancelled = true
      },
    })
    const { fetch } = routedFetch(() => new Response(stream, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const source = readStream(makeAccessor(), spec('/volume/big.bin'))[Symbol.asyncIterator]()
    const first = await source.next()
    if (first.done === true) throw new Error('stream ended before its first chunk')
    expect(first.value.byteLength).toBe(8192)
    await source.return?.()
    expect(cancelled).toBe(true)
  })

  it('raises ENOENT for missing files', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await collect(readStream(makeAccessor(), spec('/volume/gone.bin'))).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })
})
