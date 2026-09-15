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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpConnectError, HttpTimeoutError } from '../errors.ts'
import { httpFormRequest, httpRequest, isHttpError, setHttpProxyBase } from './http.ts'

const ENC = new TextEncoder()

function makeFetchMock(body: string | Uint8Array = '', status = 200) {
  const bytes = typeof body === 'string' ? ENC.encode(body) : body
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(bytes as BodyInit, {
        status,
        statusText: status === 200 ? 'OK' : 'Error',
      }),
    ),
  )
}

function urlsCalled(mock: ReturnType<typeof makeFetchMock>): string[] {
  return mock.mock.calls.map((call) => {
    const url = call[0]
    if (typeof url === 'string') return url
    if (url instanceof URL) return url.toString()
    return url.url
  })
}

describe('http proxy routing', () => {
  beforeEach(() => {
    setHttpProxyBase(null)
  })

  afterEach(() => {
    setHttpProxyBase(null)
    vi.unstubAllGlobals()
  })

  it('does not rewrite when no proxy base is set', async () => {
    const fetchMock = makeFetchMock('hello')
    vi.stubGlobal('fetch', fetchMock)
    await httpRequest('https://example.com/x')
    expect(urlsCalled(fetchMock)).toEqual(['https://example.com/x'])
  })

  it('rewrites absolute URL through proxy base when set', async () => {
    const fetchMock = makeFetchMock('hello')
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    await httpRequest('https://example.com/x')
    expect(urlsCalled(fetchMock)).toEqual(['/__proxy?url=https%3A%2F%2Fexample.com%2Fx'])
  })

  it('appends url= with & when proxy base already has a query string', async () => {
    const fetchMock = makeFetchMock('hello')
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy?key=abc')
    await httpRequest('https://example.com/x')
    expect(urlsCalled(fetchMock)).toEqual(['/__proxy?key=abc&url=https%3A%2F%2Fexample.com%2Fx'])
  })

  it('does not double-rewrite a URL that already starts with the proxy base', async () => {
    const fetchMock = makeFetchMock('hello')
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    await httpRequest('/__proxy?url=https%3A%2F%2Fexample.com%2Fx')
    expect(urlsCalled(fetchMock)).toEqual(['/__proxy?url=https%3A%2F%2Fexample.com%2Fx'])
  })

  it('does not rewrite same-origin paths starting with /', async () => {
    const fetchMock = makeFetchMock('hello')
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    await httpRequest('/api/local')
    expect(urlsCalled(fetchMock)).toEqual(['/api/local'])
  })

  it('reverts to no rewrite after proxy base is cleared', async () => {
    const fetchMock = makeFetchMock('hello')
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    await httpRequest('https://example.com/a')
    setHttpProxyBase(null)
    await httpRequest('https://example.com/b')
    expect(urlsCalled(fetchMock)).toEqual([
      '/__proxy?url=https%3A%2F%2Fexample.com%2Fa',
      'https://example.com/b',
    ])
  })

  it('routes form requests through the proxy as well', async () => {
    const fetchMock = makeFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    await httpFormRequest('https://example.com/submit', { formData: { a: '1' } })
    expect(urlsCalled(fetchMock)).toEqual(['/__proxy?url=https%3A%2F%2Fexample.com%2Fsubmit'])
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    )
  })

  it('forwards body and method untouched when proxying', async () => {
    const fetchMock = makeFetchMock('ok')
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    const body = ENC.encode('{"x":1}')
    await httpRequest('https://example.com/api', {
      method: 'PUT',
      body,
      headers: { 'Content-Type': 'application/json' },
    })
    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit]
    expect(init.method).toBe('PUT')
    expect(init.body).toBe(body)
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  // A non-2xx is data, not an error: curl exits 0 and prints the body for a
  // 404 while wget exits 8, so only the caller can decide. Throwing here is
  // what used to force both tools to fail on any 4xx.
  it('reports a non-2xx response as a status rather than throwing', async () => {
    const fetchMock = makeFetchMock('nope', 502)
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    const resp = await httpRequest('https://example.com/x')
    expect(resp.status).toBe(502)
    expect(isHttpError(resp)).toBe(true)
    expect(new TextDecoder().decode(resp.body)).toBe('nope')
  })

  it('wraps a transport failure as HttpConnectError with host and port', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    )
    setHttpProxyBase(null)
    await expect(httpRequest('http://127.0.0.1:1/x')).rejects.toThrow(HttpConnectError)
    await expect(httpRequest('http://127.0.0.1:1/x')).rejects.toMatchObject({
      host: '127.0.0.1',
      port: 1,
    })
  })
})

describe('http deadlines', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // The deadline can fire while the body is still arriving: the abort then
  // surfaces from the body read, and it is the same timeout.
  it('reports an abort during the body read as HttpTimeoutError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          arrayBuffer: () => Promise.reject(new DOMException('aborted', 'AbortError')),
        } as unknown as Response),
      ),
    )
    await expect(httpRequest('http://127.0.0.1:1/x', { timeoutMs: 50 })).rejects.toThrow(
      HttpTimeoutError,
    )
  })

  // A null deadline is curl's `--max-time 0`: nothing ever aborts.
  it('never aborts when the deadline is null', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'))
            })
            setTimeout(() => {
              resolve(new Response('late', { status: 200, statusText: 'OK' }))
            }, 120_000)
          }),
      ),
    )
    const pending = httpRequest('http://127.0.0.1:1/x', { timeoutMs: null })
    await vi.advanceTimersByTimeAsync(120_000)
    const resp = await pending
    expect(new TextDecoder().decode(resp.body)).toBe('late')
  })
})

// Redirects are followed by hand so every hop stays observable, the way
// httpx keeps `response.history` for the python twin.
describe('redirect history', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function redirectThen(
    status: number,
    method: string,
    body: string,
  ): ReturnType<typeof vi.fn<typeof fetch>> {
    return vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('302: Found', {
          status,
          statusText: 'Found',
          headers: { Location: '/hello' },
        }),
      )
      .mockResolvedValueOnce(new Response(body, { status: 200, statusText: method }))
  }

  it('keeps each followed redirect in history, in order', async () => {
    const mock = redirectThen(302, 'OK', 'hello')
    vi.stubGlobal('fetch', mock)
    const resp = await httpRequest('http://x.test/redirect', { followRedirects: true })
    expect([resp.status, resp.url]).toEqual([200, 'http://x.test/hello'])
    expect(resp.history.map((h) => [h.status, h.url, new Map(h.headers).get('location')])).toEqual([
      [302, 'http://x.test/redirect', '/hello'],
    ])
    expect(new TextDecoder().decode(resp.history[0]?.body)).toBe('302: Found')
    expect(urlsCalled(mock)).toEqual(['http://x.test/redirect', 'http://x.test/hello'])
    // Every hop is asked for by hand, so the platform never hides one.
    expect(mock.mock.calls.map((call) => call[1]?.redirect)).toEqual(['manual', 'manual'])
  })

  it('turns a POST into a GET after a 302 and drops the body', async () => {
    const mock = redirectThen(302, 'OK', 'hello')
    vi.stubGlobal('fetch', mock)
    const resp = await httpRequest('http://x.test/redirect', {
      method: 'POST',
      body: ENC.encode('a=1'),
      followRedirects: true,
    })
    expect(resp.history[0]?.method).toBe('POST')
    expect(resp.method).toBe('GET')
    expect(mock.mock.calls[1]?.[1]?.method).toBe('GET')
    expect(mock.mock.calls[1]?.[1]?.body).toBeUndefined()
  })

  it('keeps the method and body across a 307', async () => {
    const mock = redirectThen(307, 'OK', 'hello')
    vi.stubGlobal('fetch', mock)
    const resp = await httpRequest('http://x.test/redirect', {
      method: 'POST',
      body: ENC.encode('a=1'),
      followRedirects: true,
    })
    expect(resp.method).toBe('POST')
    expect(mock.mock.calls[1]?.[1]?.method).toBe('POST')
    expect(mock.mock.calls[1]?.[1]?.body).toBeDefined()
  })

  it('keeps Authorization on a same-origin hop and drops it when the origin changes', async () => {
    const same = redirectThen(302, 'OK', 'hello')
    vi.stubGlobal('fetch', same)
    await httpRequest('http://x.test/redirect', {
      headers: { Authorization: 'Bearer t' },
      followRedirects: true,
    })
    expect((same.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe(
      'Bearer t',
    )
    const away = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          statusText: 'Found',
          headers: { Location: 'http://other.test/hello' },
        }),
      )
      .mockResolvedValueOnce(new Response('hello', { status: 200, statusText: 'OK' }))
    vi.stubGlobal('fetch', away)
    const resp = await httpRequest('http://x.test/redirect', {
      headers: { Authorization: 'Bearer t' },
      followRedirects: true,
    })
    expect(resp.url).toBe('http://other.test/hello')
    expect(away.mock.calls[1]?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('returns the redirect itself when not following', async () => {
    const mock = redirectThen(302, 'OK', 'hello')
    vi.stubGlobal('fetch', mock)
    const resp = await httpRequest('http://x.test/redirect', { followRedirects: false })
    expect([resp.status, resp.history]).toEqual([302, []])
    expect(mock).toHaveBeenCalledTimes(1)
  })
})
