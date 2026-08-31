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
import { NO_RETRY, apiRequest, bodyDelay, headerDelay, type RetryPolicy } from './client.ts'

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
    await expect(failure).rejects.toThrowError(Boom)
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
    await expect(
      apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry }),
    ).rejects.toThrowError(Boom)
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
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })).rejects.toThrowError(
      Boom,
    )
    expect(fakeFetch).toHaveBeenCalledTimes(1)
  })

  it('propagates network errors without wrapping', async () => {
    const fakeFetch: typeof fetch = () => Promise.reject(new TypeError('network down'))
    await expect(apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch })).rejects.toThrowError(
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
    await expect(
      apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry }),
    ).rejects.toThrowError(TypeError)
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

  it('body mode refuses a delay it could never wait out and caps the rest', async () => {
    // JSON.parse rejects a bare NaN literal but overflows 1e999 to Infinity.
    expect(await bodyDelay(new Response('{"retry_after": 2.5}'), retry)).toBe(2.5)
    expect(await bodyDelay(new Response('{"retry_after": 7.5}'), retry)).toBe(4)
    expect(await bodyDelay(new Response('{"retry_after": 1e999}'), retry)).toBe(1)
    expect(await bodyDelay(new Response('{"retry_after": -5}'), retry)).toBe(1)
    expect(await bodyDelay(new Response('{"retry_after": "soon"}'), retry)).toBe(1)
    expect(await bodyDelay(new Response('not json'), retry)).toBe(1)
    // the 1s fallback bows to a ceiling below it
    const tight: RetryPolicy = { ...NO_RETRY, statuses: new Set([429]), maxBackoff: 0.5 }
    expect(await bodyDelay(new Response('not json'), tight)).toBe(0.5)
  })
})
