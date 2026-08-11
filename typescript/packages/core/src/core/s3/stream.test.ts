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

import { S3Accessor } from '../../accessor/s3.ts'
import type { S3Config } from '../../resource/s3/config.ts'
import { PathSpec } from '../../types.ts'
import { rangeRead, readRange } from './stream.ts'

const DEC = new TextDecoder()
const BODY = '0123456789'
const PATH = PathSpec.fromStrPath('/obj')

let restore: (() => void) | null = null

interface Served {
  requests: RequestInit[]
  cancelled: boolean
  chunks: number
}

/** What `stream()` buffers to before it yields, so a body has to exceed it
 *  for any early stop to be observable at all. */
const CHUNK = 8192

/** A presigned-fetch S3 serving `bytes`, counting what the consumer pulled. */
function serve(bytes: Uint8Array, chunkSize = CHUNK): Served {
  const served: Served = { requests: [], cancelled: false, chunks: 0 }
  const original = globalThis.fetch
  const fake = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    let at = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.byteLength) {
          controller.close()
          return
        }
        served.chunks += 1
        controller.enqueue(bytes.subarray(at, at + chunkSize))
        at += chunkSize
      },
      cancel() {
        served.cancelled = true
      },
    })
    served.requests.push(init ?? {})
    return Promise.resolve(new Response(body, { status: 200, headers: { etag: '"tag"' } }))
  })
  globalThis.fetch = fake as unknown as typeof globalThis.fetch
  restore = () => {
    globalThis.fetch = original
  }
  return served
}

function text(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function browserAccessor(): S3Accessor {
  const config: S3Config = {
    bucket: 'b',
    presignedUrlProvider: (path: string) => Promise.resolve(`https://example.test${path}`),
  }
  return new S3Accessor(config)
}

afterEach(() => {
  restore?.()
  restore = null
  vi.restoreAllMocks()
})

describe('core/s3 readRange on the presigned browser path', () => {
  it('returns the window, never the whole object', async () => {
    // The bug this pins: the presigned shim carries no Range, so a reader that
    // asked the SDK for one got the entire object back and handed it up as if
    // it were the requested bytes.
    const served = serve(text(BODY))
    const got = await readRange(browserAccessor(), PATH, undefined, 2, 3)
    expect(DEC.decode(got)).toBe('234')
    // And it stays a plain GET: a Range header here would trip the CORS
    // preflight presigned deployments generally do not allow.
    expect(served.requests.every((r) => r.headers === undefined)).toBe(true)
  })

  it('stops the transfer once the window is filled', async () => {
    // Streaming only beats fetching the whole object if the download actually
    // stops: releasing the reader's lock without cancelling would let the rest
    // of the bytes arrive anyway. `stream()` buffers to CHUNK before it yields,
    // so the object has to span several of them for the stop to be visible.
    const served = serve(new Uint8Array(CHUNK * 4))
    await readRange(browserAccessor(), PATH, undefined, 0, 10)
    expect(served.cancelled).toBe(true)
    expect(served.chunks).toBeLessThan(4)
  })

  it('runs to the end when no size is given', async () => {
    serve(text(BODY))
    const got = await readRange(browserAccessor(), PATH, undefined, 7, null)
    expect(DEC.decode(got)).toBe('789')
  })

  it('is empty for a window that starts past the end', async () => {
    serve(text(BODY))
    expect(await readRange(browserAccessor(), PATH, undefined, 99, 4)).toEqual(new Uint8Array(0))
  })

  it('stops at the end when the window runs past it', async () => {
    serve(text(BODY))
    const got = await readRange(browserAccessor(), PATH, undefined, 8, 99)
    expect(DEC.decode(got)).toBe('89')
  })

  it('assembles a window that spans several chunks', async () => {
    const whole = new Uint8Array(CHUNK * 3)
    for (let i = 0; i < whole.byteLength; i += 1) whole[i] = i % 251
    serve(whole)
    const got = await readRange(browserAccessor(), PATH, undefined, CHUNK - 5, CHUNK + 10)
    expect(got).toEqual(whole.subarray(CHUNK - 5, CHUNK * 2 + 5))
  })
})

describe('core/s3 rangeRead', () => {
  it('takes its fourth argument as one past the last byte', async () => {
    // The resource-level spelling every other backend and all of python use.
    // s3 read it as a length, so this call used to return ten bytes from
    // offset two rather than the four between two and six.
    serve(text(BODY))
    const got = await rangeRead(browserAccessor(), PATH, 2, 6)
    expect(DEC.decode(got)).toBe('2345')
  })
})
