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
import { httpFormRequest, httpRequest, setHttpProxyBase } from './http.ts'

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

  it('surfaces non-2xx responses as thrown errors', async () => {
    const fetchMock = makeFetchMock('nope', 502)
    vi.stubGlobal('fetch', fetchMock)
    setHttpProxyBase('/__proxy')
    await expect(httpRequest('https://example.com/x')).rejects.toThrow(/HTTP 502/)
  })
})
