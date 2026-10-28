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
  MAX_BODY_BYTES,
  NO_RETRY,
  apiRequest,
  apiStream,
  stallTimeout,
  bodyDelay,
  buildUrl,
  flooredDelay,
  headerDelay,
  type RetryPolicy,
} from './client.ts'
import { ResponseTooLargeError } from './errors.ts'
import { runWithEvaluation } from '../../context/session_context.ts'
import { EvaluationContext } from '../../workspace/evaluation.ts'
import { SessionState } from '../../workspace/session/session.ts'

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

function noWait(): Promise<void> {
  return Promise.resolve()
}

function dropped(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('terminated'))
      },
    }),
  )
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

  it.each(['none', 'location'] as const)(
    'cancels an unread %s body without pulling it',
    async (read) => {
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(new Uint8Array(65536))
      })
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
      const response = new Response(body, { status: 202, headers: { Location: '/monitor/1' } })
      const materialize = vi.spyOn(response, 'arrayBuffer')
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(response)
      expect(await apiRequest('POST', TARGET, { errorOf, fetchFn: fakeFetch, read })).toBe(
        read === 'none' ? null : '/monitor/1',
      )
      expect(cancel).toHaveBeenCalledOnce()
      expect(pull).not.toHaveBeenCalled()
      expect(materialize).not.toHaveBeenCalled()
      expect(body.locked).toBe(false)
    },
  )

  it.each(['none', 'location'] as const)(
    'accepts a null response body in %s mode',
    async (read) => {
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
      expect(await apiRequest('POST', TARGET, { errorOf, fetchFn: fakeFetch, read })).toBeNull()
    },
  )

  it('a raw body is sent as-is', async () => {
    let sentBody: BodyInit | null | undefined
    const fakeFetch: typeof fetch = (_url, init) => {
      sentBody = init?.body
      return Promise.resolve(jsonResponse({ ok: 4 }))
    }
    await apiRequest('PUT', TARGET, { errorOf, fetchFn: fakeFetch, body: 'a=1&b=2' })
    expect(sentBody).toBe('a=1&b=2')
  })

  it.each([30, 1.001, 0.0001])('timeout %s arms a per-attempt signal', async (timeout) => {
    let sentSignal: AbortSignal | null | undefined
    const fakeFetch: typeof fetch = (_url, init) => {
      sentSignal = init?.signal
      return Promise.resolve(jsonResponse({}))
    }
    await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, timeout })
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

  it('retries a body that drops mid-read, never a mapped error or a bad parse', async () => {
    const retry: RetryPolicy = { ...NO_RETRY, maxRetries: 2, retryTransport: true }
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(dropped())
      .mockResolvedValueOnce(jsonResponse({ ok: 6 }))
    expect(
      await apiRequest('GET', TARGET, { errorOf, fetchFn: fakeFetch, retry, sleep: noWait }),
    ).toEqual({
      ok: 6,
    })
    expect(fakeFetch).toHaveBeenCalledTimes(2)
    const bad = vi.fn<typeof fetch>().mockResolvedValue(new Response('{not json'))
    await expect(
      apiRequest('GET', TARGET, { errorOf, fetchFn: bad, retry, sleep: noWait }),
    ).rejects.toThrow(SyntaxError)
    expect(bad).toHaveBeenCalledOnce()
    const refused = vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status: 404 }))
    await expect(
      apiRequest('GET', TARGET, { errorOf, fetchFn: refused, retry, sleep: noWait }),
    ).rejects.toMatchObject({ status: 404 })
    expect(refused).toHaveBeenCalledOnce()
  })

  it('a dropped body is a transport failure, resent only under retryTransport', async () => {
    const once = vi.fn<typeof fetch>().mockResolvedValueOnce(dropped())
    const noTransport: RetryPolicy = { ...NO_RETRY, maxRetries: 2 }
    await expect(
      apiRequest('POST', TARGET, {
        errorOf,
        fetchFn: once,
        retry: noTransport,
        sleep: noWait,
        json: {},
      }),
    ).rejects.toThrow('terminated')
    expect(once).toHaveBeenCalledOnce()
    const resent = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(dropped())
      .mockResolvedValueOnce(jsonResponse({ ok: 7 }))
    expect(
      await apiRequest('POST', TARGET, {
        errorOf,
        fetchFn: resent,
        retry: { ...noTransport, retryTransport: true },
        sleep: noWait,
        json: {},
      }),
    ).toEqual({ ok: 7 })
    expect(resent).toHaveBeenCalledTimes(2)
  })

  it('an injected sleep takes every wait, in seconds', async () => {
    const waits: number[] = []
    const retry: RetryPolicy = { ...NO_RETRY, statuses: new Set([503]), maxRetries: 2 }
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '30' } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: 5 }))
    const result = await apiRequest('GET', TARGET, {
      errorOf,
      fetchFn: fakeFetch,
      retry,
      sleep: (seconds) => {
        waits.push(seconds)
        return Promise.resolve()
      },
    })
    expect(result).toEqual({ ok: 5 })
    expect(waits).toEqual([30, 2])
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
    expect(drain).not.toHaveBeenCalled()
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
  it('retries a first chunk that drops and releases a body abandoned after it', async () => {
    const retry: RetryPolicy = { ...NO_RETRY, maxRetries: 1, retryTransport: true }
    const cancel = vi.fn()
    const fakeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(dropped())
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                controller.enqueue(new Uint8Array([7]))
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        ),
      )
    const source = apiStream(TARGET, { errorOf, fetchFn: fakeFetch, retry, sleep: noWait })
    expect((await source.next()).value).toEqual(new Uint8Array([7]))
    expect(fakeFetch).toHaveBeenCalledTimes(2)
    await source.return()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('retries opening the response, never a body already yielded', async () => {
    const waits: number[] = []
    const retry: RetryPolicy = {
      ...NO_RETRY,
      statuses: new Set([503]),
      maxRetries: 2,
      retryTransport: true,
    }
    const record = (seconds: number): Promise<void> => {
      waits.push(seconds)
      return Promise.resolve()
    }
    const opening = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '3' } }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('done'))
    const parts: Uint8Array[] = []
    for await (const part of apiStream(TARGET, { errorOf, fetchFn: opening, retry, sleep: record }))
      parts.push(part)
    expect(new TextDecoder().decode(parts[0])).toBe('done')
    expect(waits).toEqual([3, 2])
    let pulls = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new Uint8Array([1]))
          else controller.error(new TypeError('terminated'))
        },
      },
      { highWaterMark: 0 },
    )
    const midway = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const source = apiStream(TARGET, { errorOf, fetchFn: midway, retry, sleep: record })
    expect((await source.next()).value).toEqual(new Uint8Array([1]))
    await expect(source.next()).rejects.toThrow('terminated')
    expect(midway).toHaveBeenCalledOnce()
  })

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

function chunkedResponse(parts: readonly Uint8Array[], init?: ResponseInit) {
  let index = 0
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const part = parts[index++]
    if (part === undefined) controller.close()
    else controller.enqueue(part)
  })
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
  return { response: new Response(body, init), body, pull, cancel }
}

describe('buffered binary limits', () => {
  it.each(['bytes', 'bytes_response'] as const)(
    '%s refuses an oversized chunked response and never retries it',
    async (read) => {
      const source = chunkedResponse([
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
        new Uint8Array([5]),
      ])
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
      const retry = { ...NO_RETRY, maxRetries: 2, retryTransport: true }
      const failure = apiRequest('GET', TARGET, {
        errorOf,
        read,
        fetchFn: fakeFetch,
        maxBodyBytes: 3,
        retry,
        sleep: noWait,
      })
      await expect(failure).rejects.toBeInstanceOf(ResponseTooLargeError)
      await expect(failure).rejects.toMatchObject({
        limit: 3,
        message: 'API response body exceeds 3 bytes',
      })
      expect(fakeFetch).toHaveBeenCalledOnce()
      expect(source.pull).toHaveBeenCalledTimes(2)
      expect(source.cancel).toHaveBeenCalledOnce()
      expect(source.body.locked).toBe(false)
    },
  )

  it('keeps overflow non-retryable when cancel also fails', async () => {
    const cleanup = new Error('cancel failed')
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
        },
        cancel() {
          return Promise.reject(cleanup)
        },
      },
      { highWaterMark: 0 },
    )
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    const failure = apiRequest('GET', TARGET, {
      errorOf,
      read: 'bytes',
      fetchFn: fakeFetch,
      maxBodyBytes: 1,
      retry: { ...NO_RETRY, retryTransport: true, maxRetries: 2 },
      sleep: noWait,
    })
    await expect(failure).rejects.toBeInstanceOf(ResponseTooLargeError)
    await expect(failure).rejects.toMatchObject({ limit: 1 })
    expect(fakeFetch).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it.each([false, true])(
    'a binary read retries transport failures only when enabled: %s',
    async (retryTransport) => {
      let pulled = false
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulled) controller.error(new TypeError('terminated'))
            else {
              pulled = true
              controller.enqueue(new Uint8Array([1]))
            }
          },
        },
        { highWaterMark: 0 },
      )
      const fakeFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(body))
        .mockResolvedValueOnce(new Response(new Uint8Array([7, 8])))
      const result = apiRequest('GET', TARGET, {
        errorOf,
        read: 'bytes',
        fetchFn: fakeFetch,
        maxBodyBytes: 2,
        retry: { ...NO_RETRY, retryTransport, maxRetries: 1 },
        sleep: noWait,
      })
      if (retryTransport) await expect(result).resolves.toEqual(new Uint8Array([7, 8]))
      else await expect(result).rejects.toThrow('terminated')
      expect(fakeFetch).toHaveBeenCalledTimes(retryTransport ? 2 : 1)
      expect(body.locked).toBe(false)
    },
  )

  it('enforces the default ceiling when no override or Content-Length exists', async () => {
    const part = new Uint8Array(65536)
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(part)
    })
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    await expect(
      apiRequest('GET', TARGET, { errorOf, read: 'bytes', fetchFn: fakeFetch }),
    ).rejects.toMatchObject({ limit: MAX_BODY_BYTES })
    expect(pull).toHaveBeenCalledTimes(MAX_BODY_BYTES / part.length + 1)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('copies byte-at-a-time chunks while growing one bounded buffer', async () => {
    const total = 17001
    const chunk = new Uint8Array(1)
    let position = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (position === total) controller.close()
          else {
            chunk[0] = position++ % 256
            controller.enqueue(chunk)
          }
        },
      },
      { highWaterMark: 0 },
    )
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    expect(
      await apiRequest('GET', TARGET, {
        errorOf,
        read: 'bytes',
        fetchFn: fakeFetch,
        maxBodyBytes: total,
      }),
    ).toEqual(Uint8Array.from({ length: total }, (_value, index) => index % 256))
    expect(body.locked).toBe(false)
  })

  it('preserves HTTP error mapping under a tiny binary cap', async () => {
    const response = new Response('backend refused this request', { status: 403 })
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(
      apiRequest('GET', TARGET, {
        errorOf,
        read: 'bytes',
        fetchFn: fakeFetch,
        maxBodyBytes: 0,
      }),
    ).rejects.toMatchObject({ status: 403, body: 'backend refused this request' })
    expect(fakeFetch).toHaveBeenCalledOnce()
  })

  it.each([429, 503])(
    'preserves HTTP %s retry handling before a bounded success',
    async (status) => {
      const fakeFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response('retry this larger error body', { status, headers: { 'Retry-After': '0' } }),
        )
        .mockResolvedValueOnce(new Response(new Uint8Array([7, 8])))
      expect(
        await apiRequest('GET', TARGET, {
          errorOf,
          read: 'bytes',
          fetchFn: fakeFetch,
          maxBodyBytes: 2,
          retry: { ...NO_RETRY, statuses: new Set([status]), maxRetries: 2 },
          sleep: noWait,
        }),
      ).toEqual(new Uint8Array([7, 8]))
      expect(fakeFetch).toHaveBeenCalledTimes(2)
    },
  )

  it('counts decoded chunks rather than trusting Content-Length', async () => {
    const source = chunkedResponse([new Uint8Array([1, 2, 3])], {
      headers: { 'Content-Length': '1' },
    })
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
    await expect(
      apiRequest('GET', TARGET, { errorOf, read: 'bytes', fetchFn: fakeFetch, maxBodyBytes: 2 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError)
    expect(source.cancel).toHaveBeenCalledOnce()
  })

  it('keeps only the requested window when a 200 response ignores Range', async () => {
    const source = chunkedResponse([
      new TextEncoder().encode('prefix'),
      new TextEncoder().encode('234tail'),
      new TextEncoder().encode('never pulled'),
    ])
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
    const out = await apiRequest('GET', TARGET, {
      errorOf,
      read: 'bytes',
      fetchFn: fakeFetch,
      window: { offset: 6, size: 3 },
      maxBodyBytes: 3,
    })
    expect(out).toEqual(new TextEncoder().encode('234'))
    expect(source.pull).toHaveBeenCalledTimes(2)
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.body.locked).toBe(false)
  })

  it.each([200, 206])(
    'rejects a %s range whose retained bytes exceed the configured cap',
    async (status) => {
      const source = chunkedResponse([new Uint8Array([1, 2, 3, 4])], { status })
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
      await expect(
        apiRequest('GET', TARGET, {
          errorOf,
          read: 'bytes',
          fetchFn: fakeFetch,
          window: { offset: 0, size: 4 },
          maxBodyBytes: 3,
        }),
      ).rejects.toMatchObject({ limit: 3 })
      expect(source.cancel).toHaveBeenCalledOnce()
    },
  )

  it.each([200, 206])(
    'bounds an open-ended %s range without counting a skipped prefix',
    async (status) => {
      const prefix = status === 200 ? [new TextEncoder().encode('prefix')] : []
      const source = chunkedResponse([...prefix, new Uint8Array([1, 2, 3, 4])], { status })
      const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
      await expect(
        apiRequest('GET', TARGET, {
          errorOf,
          read: 'bytes',
          fetchFn: fakeFetch,
          window: { offset: 6, size: null },
          maxBodyBytes: 3,
        }),
      ).rejects.toMatchObject({ limit: 3 })
      expect(source.cancel).toHaveBeenCalledOnce()
    },
  )

  it('refuses an oversized 206 response instead of silently truncating it', async () => {
    const source = chunkedResponse([new Uint8Array([2, 3, 4]), new Uint8Array([5])], {
      status: 206,
    })
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
    await expect(
      apiRequest('GET', TARGET, {
        errorOf,
        read: 'bytes',
        fetchFn: fakeFetch,
        window: { offset: 2, size: 3 },
        maxBodyBytes: 10,
      }),
    ).rejects.toMatchObject({ limit: 3 })
    expect(source.cancel).toHaveBeenCalledOnce()
  })

  it.each([0, 3])('accepts an exact %s-byte cap and observes EOF', async (size) => {
    const parts = size === 0 ? [] : [new Uint8Array([1, 2, 3])]
    const source = chunkedResponse(parts)
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
    expect(
      await apiRequest('GET', TARGET, {
        errorOf,
        read: 'bytes',
        fetchFn: fakeFetch,
        maxBodyBytes: size,
      }),
    ).toEqual(new Uint8Array(size === 0 ? [] : [1, 2, 3]))
    expect(source.cancel).not.toHaveBeenCalled()
    expect(source.body.locked).toBe(false)
  })

  it('accepts a short 206 response at EOF without shifting it by the offset', async () => {
    const source = chunkedResponse([new Uint8Array([7, 8])], { status: 206 })
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
    expect(
      await apiRequest('GET', TARGET, {
        errorOf,
        read: 'bytes',
        fetchFn: fakeFetch,
        window: { offset: 20, size: 4 },
        maxBodyBytes: 4,
      }),
    ).toEqual(new Uint8Array([7, 8]))
    expect(source.cancel).not.toHaveBeenCalled()
    expect(source.body.locked).toBe(false)
  })

  it('refuses a nonempty body under a zero-byte cap', async () => {
    const source = chunkedResponse([new Uint8Array([1])])
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
    await expect(
      apiRequest('GET', TARGET, { errorOf, read: 'bytes', fetchFn: fakeFetch, maxBodyBytes: 0 }),
    ).rejects.toMatchObject({ limit: 0 })
    expect(source.cancel).toHaveBeenCalledOnce()
  })

  it('accepts EOF before an ignored Range starts', async () => {
    const source = chunkedResponse([new Uint8Array([1, 2, 3])])
    const fakeFetch = vi.fn<typeof fetch>().mockResolvedValue(source.response)
    expect(
      await apiRequest('GET', TARGET, {
        errorOf,
        read: 'bytes',
        fetchFn: fakeFetch,
        window: { offset: 9, size: 2 },
        maxBodyBytes: 2,
      }),
    ).toEqual(new Uint8Array())
    expect(source.cancel).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid cap %s before fetching',
    async (maxBodyBytes) => {
      const fakeFetch = vi.fn<typeof fetch>()
      await expect(
        apiRequest('GET', TARGET, { errorOf, read: 'bytes', fetchFn: fakeFetch, maxBodyBytes }),
      ).rejects.toThrow('max_body_bytes must be a non-negative safe integer')
      expect(fakeFetch).not.toHaveBeenCalled()
    },
  )
})

describe('stallTimeout', () => {
  // A body that drips one byte after each gap, and errors with the request's
  // abort reason the way a real fetch body does.
  function drip(gapsMs: readonly number[]): typeof fetch {
    return (_input, init) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          signal?.addEventListener('abort', () => {
            controller.error(signal.reason)
          })
          for (const gap of gapsMs) {
            await new Promise((done) => setTimeout(done, gap))
            if (signal?.aborted === true) return
            controller.enqueue(new Uint8Array([120]))
          }
          controller.close()
        },
      })
      return Promise.resolve(new Response(body))
    }
  }

  it('lets a body that keeps flowing outlive the bound', async () => {
    const response = await stallTimeout(0.05, drip([20, 20, 20, 20, 20]))(TARGET)
    expect(await response.text()).toBe('xxxxx')
  })

  it('fails a body that stops flowing at the bound', async () => {
    const response = await stallTimeout(0.05, drip([0, 500]))(TARGET)
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

// A request a command makes answers to the call it runs in: the line that
// stops, or the job that is killed or past its limit, ends the request, as
// Python cancels the task that awaits it, and no retry follows.
describe("the call's signal", () => {
  it('a stopped call ends its request and retries nothing', async () => {
    const stop = new AbortController()
    const evaluation = new EvaluationContext(new SessionState({ sessionId: 's' }))
    evaluation.frame.abortSignal = stop.signal
    let calls = 0
    const hang: typeof fetch = (_input, init) => {
      calls += 1
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(init.signal?.reason as Error)
          },
          { once: true },
        )
      })
    }
    const retry: RetryPolicy = { ...NO_RETRY, maxRetries: 3, retryTransport: true }
    const pending = runWithEvaluation(evaluation, () =>
      apiRequest('GET', TARGET, { errorOf, fetchFn: hang, retry }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    stop.abort()
    await expect(pending).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
