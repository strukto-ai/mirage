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
import { DiscordApiError, HttpDiscordTransport } from './client.ts'

class TestTransport extends HttpDiscordTransport {
  constructor(
    private readonly base: string,
    private readonly auth: Record<string, string>,
    fetchImpl: typeof fetch,
  ) {
    super()
    ;(this as unknown as { fetch: typeof fetch }).fetch = fetchImpl
  }
  protected baseUrl(): string {
    return this.base
  }
  protected authHeaders(): Record<string, string> {
    return this.auth
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('HttpDiscordTransport', () => {
  it('GET endpoint with params', async () => {
    let url = ''
    const fakeFetch: typeof fetch = (u, init) => {
      url = u instanceof URL ? u.toString() : typeof u === 'string' ? u : u.url
      expect(init?.method ?? 'GET').toBe('GET')
      return Promise.resolve(jsonResponse([{ id: 'g1' }]))
    }
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    const out: unknown = await t.call('GET', '/users/@me/guilds')
    expect(url).toBe('https://discord.com/api/v10/users/@me/guilds')
    expect(out).toEqual([{ id: 'g1' }])
  })

  it('POST sends JSON body with content-type header', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ id: 'M1', content: 'hi' })),
    )
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    await t.call('POST', '/channels/C1/messages', undefined, { content: 'hi' })
    const init = fakeFetch.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify({ content: 'hi' }))
    const headers = new Headers(init?.headers)
    expect(headers.get('content-type')).toMatch(/application\/json/)
    expect(headers.get('Authorization')).toBe('Bot x')
  })

  it('PUT does not send a body and 204 returns null', async () => {
    const fakeFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    )
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    const out = await t.call('PUT', '/channels/C1/messages/M1/reactions/%F0%9F%91%8D/@me')
    const init = fakeFetch.mock.calls[0]?.[1]
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBeUndefined()
    expect(out).toBeNull()
  })

  it('serializes mixed-type query params', async () => {
    let url = ''
    const fakeFetch: typeof fetch = (u) => {
      url = u instanceof URL ? u.toString() : typeof u === 'string' ? u : u.url
      return Promise.resolve(jsonResponse([]))
    }
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    await t.call('GET', '/channels/C1/messages', { limit: 50, before: '12345' })
    const qIdx = url.indexOf('?')
    expect(qIdx).toBeGreaterThan(-1)
    const query = url.slice(qIdx + 1)
    expect(query.split('&')).toEqual(expect.arrayContaining(['limit=50', 'before=12345']))
  })

  it('propagates network errors without wrapping', async () => {
    const fakeFetch: typeof fetch = () => Promise.reject(new TypeError('network down'))
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    await expect(t.call('GET', '/users/@me/guilds')).rejects.toThrow(TypeError)
    await expect(t.call('GET', '/users/@me/guilds')).rejects.not.toThrow(DiscordApiError)
  })

  it('429 with retry_after retries and succeeds', async () => {
    let calls = 0
    const fakeFetch: typeof fetch = () => {
      calls += 1
      if (calls === 1) return Promise.resolve(jsonResponse({ retry_after: 0.001 }, 429))
      return Promise.resolve(jsonResponse([{ id: 'g1' }]))
    }
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    const out = await t.call('GET', '/users/@me/guilds')
    expect(calls).toBe(2)
    expect(out).toEqual([{ id: 'g1' }])
  })

  it('429 after MAX_RETRIES throws DiscordApiError', async () => {
    const fakeFetch: typeof fetch = () => Promise.resolve(jsonResponse({ retry_after: 0.001 }, 429))
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    await expect(t.call('GET', '/users/@me/guilds')).rejects.toThrow(DiscordApiError)
  })

  it('non-2xx throws DiscordApiError with status', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(jsonResponse({ message: 'Unauthorized' }, 401))
    const t = new TestTransport(
      'https://discord.com/api/v10',
      { Authorization: 'Bot x' },
      fakeFetch,
    )
    await expect(t.call('GET', '/users/@me/guilds')).rejects.toMatchObject({
      status: 401,
      endpoint: '/users/@me/guilds',
    })
  })
})
