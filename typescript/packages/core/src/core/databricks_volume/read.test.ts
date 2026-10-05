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
import { read } from './read.ts'
import { makeAccessor, notFoundResponse, routedFetch, spec } from './_test_util.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readBytes', () => {
  it('downloads whole files without a Range header', async () => {
    const { fetch, calls } = routedFetch(() => new Response('hello', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const data = await read(makeAccessor(), spec('/volume/a.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
    expect(calls[0]?.headers.Range).toBeUndefined()
  })

  it('sends Range for offset/size reads', async () => {
    const { fetch, calls } = routedFetch(() => new Response('ell', { status: 206 }))
    vi.stubGlobal('fetch', fetch)
    const data = await read(makeAccessor(), spec('/volume/a.txt'), undefined, {
      offset: 1,
      size: 3,
    })
    expect(new TextDecoder().decode(data)).toBe('ell')
    expect(calls[0]?.headers.Range).toBe('bytes=1-3')
  })

  // A gateway in front of the Files API may answer 200 with the whole
  // object, which is a legal answer to a Range request and used to be
  // handed back whole for what the caller asked to be a window.
  it('slices locally when the server ignores the range', async () => {
    const { fetch } = routedFetch(() => new Response('hello', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const data = await read(makeAccessor(), spec('/volume/a.txt'), undefined, {
      offset: 1,
      size: 3,
    })
    expect(new TextDecoder().decode(data)).toBe('ell')
  })

  it('short-circuits size=0 reads without a request', async () => {
    const { fetch, calls } = routedFetch(() => new Response('x', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const data = await read(makeAccessor(), spec('/volume/a.txt'), undefined, { size: 0 })
    expect(data.byteLength).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('raises ENOENT for missing files', async () => {
    const { fetch } = routedFetch(() => notFoundResponse())
    vi.stubGlobal('fetch', fetch)
    const err = (await read(makeAccessor(), spec('/volume/gone.txt')).catch(
      (e: unknown) => e,
    )) as Error & { code?: string }
    expect(err.code).toBe('ENOENT')
  })
})
