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

import { describe, expect, it, vi } from 'vitest'
import {
  NO_RETRY,
  apiRequest,
  apiStream,
  bodyDelay,
  buildUrl,
  flooredDelay,
  headerDelay,
  type RetryPolicy,
} from './client.ts'

const TARGET = 'https://api.test/v1/thing'

class Boom extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`boom ${String(status)}`)
  }
}

function errorOf(response: Response, body: string): Error {
  return new Boom(response.status, body)
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('apiRequest', () => {
  it('returns the parsed body', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ ok: true })))
    const out = await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })
    expect(out).toEqual({ ok: true })
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('an empty body is null', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    expect(await apiRequest('PUT', TARGET, { errorOf, fetchFn: fakeFetch })).toBeNull()
  })

  it('params reach the query string and the json body is serialized', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({})))
    await apiRequest('POST', TARGET, {
      errorOf,
      fetchFn: fakeFetch,
      params: { a: 1, b: 'x' },
      json: { content: 'hi' },
      headers: { Authorization: 'Bearer t' },
    })
    const [url, init] = fakeFetch.mock.calls[0] ?? []
    expect(url).toBe(`${TARGET}?a=1&b=x`)
    expect(init?.body).toBe(JSON.stringify({ content: 'hi' }))
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer t')
  })

  it('an error status maps through the hook', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ message: 'nope' }, 404)),
    )
    const failure = apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })
    await expect(failure).rejects.toThrow(Boom)
    await expect(failure).rejects.toMatchObject({
      status: 404,
      body: JSON.stringify({ message: 'nope' }),
    })
  })

  it('body-mode retry waits out the retryable statuses', async () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      statuses: new Set([429]),
      maxRetries: 2,
      delaySource: 'body',
    }
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ retry_after: 0.001 }, 429))
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }))
    const out = await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })
    expect(out).toEqual({ ok: 1 })
    expect(fakeFetch).toHaveBeenCalledTimes(2)
  })

  it('exhausted retries map through the hook', async () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      statuses: new Set([429]),
      maxRetries: 2,
      delaySource: 'body',
    }
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ retry_after: 0.001 }, 429)),
    )
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })).rejects.toThrow(
      Boom,
    )
    expect(fakeFetch).toHaveBeenCalledTimes(3)
  })

  it('header-mode retry honors Retry-After', async () => {
    const retry: RetryPolicy = { ...NO_RETRY, statuses: new Set([503]), maxRetries: 1 }
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { 'Retry-After': '0.001' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: 2 }))
    const out = await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })
    expect(out).toEqual({ ok: 2 })
  })

  it('does not retry by default', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ retry_after: 30 }, 429)),
    )
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })).rejects.toThrow(Boom)
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('propagates network errors without wrapping', async () => {
    const fakeFetch: typeof fetch = () => Promise.reject(new TypeError('network down'))
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })).rejects.toThrow(
      TypeError,
    )
  })

  it('transport retry replays a rejected attempt', async () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      maxRetries: 2,
      maxBackoff: 0.001,
      retryTransport: true,
    }
    let calls = 0
    const fakeFetch: typeof fetch = () => {
      calls += 1
      if (calls === 1) return Promise.reject(new TypeError('network down'))
      return Promise.resolve(jsonResponse({ ok: 5 }))
    }
    const out = await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })
    expect(out).toEqual({ ok: 5 })
    expect(calls).toBe(2)
  })

  it('transport retry exhaustion rethrows the transport error', async () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      maxRetries: 1,
      maxBackoff: 0.001,
      retryTransport: true,
    }
    const fakeFetch: typeof fetch = () => Promise.reject(new TypeError('network down'))
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })).rejects.toThrow(
      TypeError,
    )
  })

  it('bytes mode sends the range and trims an ignored one', async () => {
    // a server may legally answer 200 with the whole body to a Range
    // request; the window trims it client-side
    let sentRange: string | null = null
    const fakeFetch: typeof fetch = (_url, init) => {
      sentRange = new Headers(init?.headers).get('Range')
      return Promise.resolve(new Response(new TextEncoder().encode('0123456789'), { status: 200 }))
    }
    const out = await apiRequest('GET', TARGET, {
      errorOf,
      fetchFn: fakeFetch,
      read: 'bytes',
      window: { offset: 2, size: 3 },
    })
    expect(out).toEqual(new TextEncoder().encode('234'))
    expect(sentRange).toBe('bytes=2-4')
  })

  it('bytes mode trusts a 206 window', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response(new TextEncoder().encode('234'), { status: 206 }))
    const out = await apiRequest('GET', TARGET, {
      errorOf,
      fetchFn: fakeFetch,
      read: 'bytes',
      window: { offset: 2, size: 3 },
    })
    expect(out).toEqual(new TextEncoder().encode('234'))
  })

  it('text mode returns the raw body', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(new Response('not json at all', { status: 200 }))
    expect(await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, read: 'text' })).toBe(
      'not json at all',
    )
  })

  it('location mode returns the header', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response(null, { status: 202, headers: { Location: 'https://api.test/monitor/1' } }),
      )
    expect(
      await apiRequest('POST', TARGET, { errorOf, fetchFn: fakeFetch, read: 'location' }),
    ).toBe('https://api.test/monitor/1')
  })

  it('drains the body on read none so the connection is released', async () => {
    const response = jsonResponse({ ok: true })
    const drain = vi.spyOn(response, 'arrayBuffer')
    const fakeFetch: typeof fetch = () => Promise.resolve(response)
    expect(
      await apiRequest('POST', TARGET, { errorOf, fetchFn: fakeFetch, read: 'none' }),
    ).toBeNull()
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('drains the body on read location while returning the header', async () => {
    const response = new Response('ignored', {
      status: 202,
      headers: { Location: 'https://api.test/monitor/1' },
    })
    const drain = vi.spyOn(response, 'arrayBuffer')
    const fakeFetch: typeof fetch = () => Promise.resolve(response)
    expect(
      await apiRequest('POST', TARGET, { errorOf, fetchFn: fakeFetch, read: 'location' }),
    ).toBe('https://api.test/monitor/1')
    expect(drain).toHaveBeenCalledTimes(1)
  })

  it('a raw body is sent as-is', async () => {
    let sentBody: BodyInit | null | undefined
    const fakeFetch: typeof fetch = (_url, init) => {
      sentBody = init?.body
      return Promise.resolve(jsonResponse({ ok: 4 }))
    }
    await apiRequest('PUT', TARGET, { errorOf, fetchFn: fakeFetch, body: 'a=1&b=2' })
    expect(sentBody).toBe('a=1&b=2')
  })

  it('timeoutSeconds arms a per-attempt signal', async () => {
    let sentSignal: AbortSignal | null | undefined
    const fakeFetch: typeof fetch = (_url, init) => {
      sentSignal = init?.signal
      return Promise.resolve(jsonResponse({}))
    }
    await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, timeoutSeconds: 30 })
    expect(sentSignal).toBeInstanceOf(AbortSignal)
  })
})

describe('retry delays', () => {
  const retry: RetryPolicy = { ...NO_RETRY, statuses: new Set([429]), maxBackoff: 4 }

  it('header mode prefers Retry-After and caps every wait', () => {
    const withHeader = new Response(null, { headers: { 'Retry-After': '2.5' } })
    expect(headerDelay(withHeader, 0, retry)).toBe(2.5)
    // maxBackoff is the ceiling on server-asked waits too, so a Retry-After
    // above it cannot stall a command past the configured limit
    const aboveCap = new Response(null, { headers: { 'Retry-After': '7.5' } })
    expect(headerDelay(aboveCap, 0, retry)).toBe(4)
    expect(headerDelay(new Response(null), 1, retry)).toBe(2)
    expect(headerDelay(new Response(null), 6, retry)).toBe(4)
  })

  it('header mode refuses a delay it could never wait out', () => {
    // setTimeout clamps NaN and Infinity to 1ms, so an unguarded value
    // turns the wait into a hot retry; a negative delay does the same.
    for (const value of ['soon', 'NaN', 'Infinity', '-Infinity', '-5']) {
      const response = new Response(null, { headers: { 'Retry-After': value } })
      expect(headerDelay(response, 0, retry)).toBe(1)
    }
  })

  it('body mode refuses a delay it could never wait out and caps the rest', () => {
    // JSON.parse rejects a bare NaN literal but overflows 1e999 to Infinity.
    expect(bodyDelay('{"retry_after": 2.5}', retry)).toBe(2.5)
    expect(bodyDelay('{"retry_after": 7.5}', retry)).toBe(4)
    expect(bodyDelay('{"retry_after": 1e999}', retry)).toBe(1)
    expect(bodyDelay('{"retry_after": -5}', retry)).toBe(1)
    expect(bodyDelay('{"retry_after": "soon"}', retry)).toBe(1)
    expect(bodyDelay('not json', retry)).toBe(1)
    // the 1s fallback bows to a ceiling below it
    const tight: RetryPolicy = { ...NO_RETRY, statuses: new Set([429]), maxBackoff: 0.5 }
    expect(bodyDelay('not json', tight)).toBe(0.5)
  })

  it('a vetoed retryable status maps through the hook at once', async () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      statuses: new Set([429]),
      maxRetries: 2,
      retryable: (_status, text) => !text.includes('QUOTA'),
    }
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ error: { type: 'QUOTA' } }, 429)),
    )
    const failure = apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })
    await expect(failure).rejects.toMatchObject({ status: 429 })
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('an unvetoed status waits out its floor before retrying', async () => {
    vi.useFakeTimers()
    try {
      const retry: RetryPolicy = {
        ...NO_RETRY,
        statuses: new Set([429]),
        maxRetries: 1,
        retryable: (_status, text) => !text.includes('QUOTA'),
        minDelays: { 429: 30 },
      }
      const fakeFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ error: { type: 'SLOW_DOWN' } }, 429))
        .mockResolvedValueOnce(jsonResponse({ ok: 4 }))
      const pending = apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry })
      await vi.advanceTimersByTimeAsync(29_000)
      expect(fakeFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await pending).toEqual({ ok: 4 })
      expect(fakeFetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flooredDelay raises to the status floor under the cap', () => {
    const retry: RetryPolicy = {
      ...NO_RETRY,
      statuses: new Set([429, 503]),
      maxBackoff: 20,
      minDelays: { 429: 30 },
    }
    expect(flooredDelay(1, 429, retry)).toBe(20)
    expect(flooredDelay(1, 503, retry)).toBe(1)
    const wide: RetryPolicy = { ...NO_RETRY, statuses: new Set([429]), minDelays: { 429: 5 } }
    expect(flooredDelay(1, 429, wide)).toBe(5)
    expect(flooredDelay(8, 429, wide)).toBe(8)
  })
})

describe('bytes_response read', () => {
  it('returns the window and the lower-cased headers of the response the bytes came in', async () => {
    // fetch follows a redirect and hands back only the final hop, whose ETag
    // is the one that describes these bytes. The server ignores Range here,
    // which it may legally do, so the window has to trim client side.
    const response = new Response(new TextEncoder().encode('0123456789'), {
      status: 200,
      headers: { ETag: '"final-hop"', 'X-Mixed-Case': 'kept' },
    })
    const drain = vi.spyOn(response, 'arrayBuffer')
    const fakeFetch: typeof fetch = () => Promise.resolve(response)
    const out = (await apiRequest('GET', TARGET, {
      errorOf,
      fetchFn: fakeFetch,
      read: 'bytes_response',
      window: { offset: 2, size: 3 },
    })) as { data: Uint8Array; status: number; headers: Record<string, string> }
    expect(out.data).toEqual(new TextEncoder().encode('234'))
    expect(out.status).toBe(200)
    expect(out.headers.etag).toBe('"final-hop"')
    expect(out.headers['x-mixed-case']).toBe('kept')
    // Read once, as bytes; a text read would have mangled binary content.
    expect(drain).toHaveBeenCalledTimes(1)
  })
})

describe('a repeated header', () => {
  it.each(['bytes_response', 'response'] as const)(
    'reads joined on a %s read, the way python joins it',
    async (read) => {
      // Two ETags name no single version; joined, the value matches no token.
      const headers = new Headers({ 'Content-Type': 'application/json' })
      headers.append('ETag', '"one"')
      headers.append('ETag', '"two"')
      const fakeFetch: typeof fetch = () =>
        Promise.resolve(new Response('{"ok":true}', { status: 200, headers }))
      const out = (await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, read })) as {
        headers: Record<string, string>
      }
      expect(out.headers.etag).toBe('"one", "two"')
    },
  )
})

describe('apiStream', () => {
  it('bounds chunks, pulls on demand and cancels an abandoned response', async () => {
    let pulls = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++
          controller.enqueue(new Uint8Array(65536).fill(42))
        },
        cancel,
      },
      { highWaterMark: 0 },
    )
    const response = new Response(body)
    const materialize = vi.spyOn(response, 'arrayBuffer')
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(response)
    const source = apiStream(TARGET, { errorOf, fetchFn: fakeFetch })
    expect(pulls).toBe(0)
    expect((await source.next()).value).toEqual(new Uint8Array(16384).fill(42))
    expect((await source.next()).value?.byteLength).toBe(16384)
    expect(pulls).toBe(1)
    expect(materialize).not.toHaveBeenCalled()
    await source.return()
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('preserves bytes split through UTF-8 and maps HTTP errors before yielding', async () => {
    const data = new TextEncoder().encode(('a'.repeat(16383) + 'é\n').repeat(4))
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(data))
    const parts: Uint8Array[] = []
    for await (const part of apiStream(TARGET, { errorOf, fetchFn: fakeFetch })) {
      expect(part.byteLength).toBeLessThanOrEqual(16384)
      parts.push(part)
    }
    expect(await new Blob(parts as BlobPart[]).text()).toBe(new TextDecoder().decode(data))
    fakeFetch.mockResolvedValue(new Response('denied', { status: 403 }))
    await expect(apiStream(TARGET, { errorOf, fetchFn: fakeFetch }).next()).rejects.toMatchObject({
      status: 403,
      body: 'denied',
    })
  })

  it('releases a response whose body fails after the first chunk', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new Uint8Array([1]))
          else controller.error(new Error('broken body'))
        },
      },
      { highWaterMark: 0 },
    )
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const source = apiStream(TARGET, { errorOf, fetchFn: fakeFetch })
    await source.next()
    await expect(source.next()).rejects.toThrow('broken body')
    expect(body.locked).toBe(false)
  })
})

it('releases a stalled streamed response when its fetch signal is aborted', async () => {
  const abort = new AbortController()
  let pending: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        pending = controller
      },
    },
    { highWaterMark: 0 },
  )
  const fakeFetch = vi.fn<typeof fetch>((_url, init) => {
    init?.signal?.addEventListener(
      'abort',
      () => {
        pending?.error(new DOMException('cancelled', 'AbortError'))
      },
      { once: true },
    )
    return Promise.resolve(new Response(body))
  })
  const source = apiStream(TARGET, { errorOf, fetchFn: fakeFetch, signal: abort.signal })
  const pulling = source.next()
  abort.abort()
  await expect(pulling).rejects.toMatchObject({ name: 'AbortError' })
  expect(body.locked).toBe(false)
})

describe('buildUrl', () => {
  it('joins with one slash and encodes the defined query entries', () => {
    expect(buildUrl('http://h/', 'api/x', { a: 'b c', n: 2, skip: undefined })).toBe(
      'http://h/api/x?a=b%20c&n=2',
    )
    expect(buildUrl('http://h', '/api/x', {})).toBe('http://h/api/x')
  })
})
