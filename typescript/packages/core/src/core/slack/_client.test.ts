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
import { HttpSlackTransport, SlackApiError } from './_client.ts'

class TestTransport extends HttpSlackTransport {
  constructor(
    private readonly base: string,
    private readonly auth: Record<string, string>,
    public readonly fetchImpl: typeof fetch,
  ) {
    super()
    // Inject the fetch implementation into the base class via a private hook.
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

describe('HttpSlackTransport', () => {
  it('GET when body is undefined; URL = base/endpoint with params', async () => {
    let observedUrl = ''
    let observedMethod = ''
    const fakeFetch: typeof fetch = (url, init) => {
      observedUrl = (url as URL).href
      observedMethod = init?.method ?? 'GET'
      return Promise.resolve(jsonResponse({ ok: true, members: [] }))
    }
    const t = new TestTransport('https://slack.com/api', { Authorization: 'Bearer x' }, fakeFetch)
    const data = await t.call('users.list', { limit: '5' })
    expect(observedMethod).toBe('GET')
    expect(observedUrl).toBe('https://slack.com/api/users.list?limit=5')
    expect(data.ok).toBe(true)
  })

  it('POST when body is provided; body is JSON stringified', async () => {
    let observedBody: string | undefined
    let observedMethod = ''
    const fakeFetch: typeof fetch = (_url, init) => {
      observedMethod = init?.method ?? ''
      observedBody = init?.body as string
      return Promise.resolve(jsonResponse({ ok: true, ts: '1.0' }))
    }
    const t = new TestTransport('https://slack.com/api', { Authorization: 'Bearer x' }, fakeFetch)
    await t.call('chat.postMessage', undefined, { channel: 'C1', text: 'hi' })
    expect(observedMethod).toBe('POST')
    expect(observedBody).toBe(JSON.stringify({ channel: 'C1', text: 'hi' }))
  })

  it('throws SlackApiError when ok=false', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(jsonResponse({ ok: false, error: 'channel_not_found' }))
    const t = new TestTransport('https://slack.com/api', {}, fakeFetch)
    await expect(t.call('conversations.history', { channel: 'C1' })).rejects.toBeInstanceOf(
      SlackApiError,
    )
    await expect(t.call('conversations.history', { channel: 'C1' })).rejects.toThrow(
      /channel_not_found/,
    )
  })

  it('missing_scope error surfaces needed and provided scopes', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          ok: false,
          error: 'missing_scope',
          needed: 'im:read,mpim:read',
          provided: 'channels:read,users:read',
        }),
      )
    const t = new TestTransport('https://slack.com/api', {}, fakeFetch)
    let caught: unknown = null
    try {
      await t.call('conversations.list')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SlackApiError)
    const err = caught as SlackApiError
    expect(err.needed).toBe('im:read,mpim:read')
    expect(err.provided).toBe('channels:read,users:read')
    expect(err.message).toMatch(/needed: im:read,mpim:read/)
    expect(err.message).toMatch(/provided: channels:read,users:read/)
  })

  it('missing_scope without needed field falls back to base message', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(jsonResponse({ ok: false, error: 'missing_scope' }))
    const t = new TestTransport('https://slack.com/api', {}, fakeFetch)
    await expect(t.call('conversations.list')).rejects.toThrow(
      /Slack API error \(conversations\.list\): missing_scope$/,
    )
  })

  it('missing_scope with empty provided renders provided as (none)', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        jsonResponse({
          ok: false,
          error: 'missing_scope',
          needed: 'im:read',
          provided: '',
        }),
      )
    const t = new TestTransport('https://slack.com/api', {}, fakeFetch)
    await expect(t.call('conversations.list')).rejects.toThrow(/provided: \(none\)/)
  })

  it('attaches auth headers + Content-Type', async () => {
    let observedHeaders: HeadersInit | undefined
    const fakeFetch: typeof fetch = (_url, init) => {
      observedHeaders = init?.headers
      return Promise.resolve(jsonResponse({ ok: true }))
    }
    const t = new TestTransport(
      'https://slack.com/api',
      { Authorization: 'Bearer xyz', 'X-User': 'u1' },
      fakeFetch,
    )
    await t.call('auth.test')
    const h = new Headers(observedHeaders)
    expect(h.get('Authorization')).toBe('Bearer xyz')
    expect(h.get('X-User')).toBe('u1')
    expect(h.get('Content-Type')).toMatch(/application\/json/)
  })
})
