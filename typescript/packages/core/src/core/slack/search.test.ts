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
import { SlackAccessor } from '../../accessor/slack.ts'
import { NodeSlackTransport, type SlackResponse, type SlackTransport } from './_client.ts'
import { searchFiles, searchMessages } from './search.ts'

const DEC = new TextDecoder()

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: () => SlackResponse = () => ({ ok: true })) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder())
  }
}

describe('searchMessages', () => {
  it('calls search.messages with query, count, page, sort=timestamp', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: { matches: [] } }))
    const out = await searchMessages(new SlackAccessor(t), 'hello', 5)
    expect(t.calls[0]?.endpoint).toBe('search.messages')
    expect(t.calls[0]?.params).toEqual({
      query: 'hello',
      count: '5',
      page: '1',
      sort: 'timestamp',
    })
    const parsed = JSON.parse(DEC.decode(out)) as { ok: boolean }
    expect(parsed.ok).toBe(true)
  })

  it('defaults count to 20 and page to 1', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await searchMessages(new SlackAccessor(t), 'q')
    expect(t.calls[0]?.params).toMatchObject({ count: '20', page: '1' })
  })

  it('forwards explicit page number', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    await searchMessages(new SlackAccessor(t), 'q', 50, 3)
    expect(t.calls[0]?.params).toMatchObject({ count: '50', page: '3' })
  })

  it('returns bytes encoding the JSON response', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: { matches: [{ ts: '1.0' }] } }))
    const out = await searchMessages(new SlackAccessor(t), 'q')
    const decoded = JSON.parse(DEC.decode(out)) as {
      messages: { matches: { ts: string }[] }
    }
    expect(decoded.messages.matches[0]?.ts).toBe('1.0')
  })

  it('uses search token override when transport is NodeSlackTransport with searchToken', async () => {
    const observedAuths: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      observedAuths.push(headers.Authorization ?? '')
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, messages: { matches: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      const transport = new NodeSlackTransport('main-token', 'search-token')
      await searchMessages(new SlackAccessor(transport), 'q')
      expect(observedAuths[0]).toBe('Bearer search-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('falls back to the accessor transport when no search token', async () => {
    const observedAuths: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((_url: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      observedAuths.push(headers.Authorization ?? '')
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, messages: { matches: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }) as typeof fetch
    try {
      const transport = new NodeSlackTransport('main-token')
      await searchMessages(new SlackAccessor(transport), 'q')
      expect(observedAuths[0]).toBe('Bearer main-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('searchFiles', () => {
  it('calls search.files with query, count, page, sort=timestamp', async () => {
    const t = new FakeTransport(() => ({ ok: true, files: { matches: [] } }))
    await searchFiles(new SlackAccessor(t), 'doc', 5, 2)
    expect(t.calls[0]?.endpoint).toBe('search.files')
    expect(t.calls[0]?.params).toEqual({
      query: 'doc',
      count: '5',
      page: '2',
      sort: 'timestamp',
    })
  })
})
