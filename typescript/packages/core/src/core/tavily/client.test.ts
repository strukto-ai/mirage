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
import { TavilyAccessor } from '../../accessor/tavily.ts'
import {
  TavilyAPIError,
  TavilyKeylessLimit,
  TavilyUnanswered,
  tavilyRequest,
  timedBody,
} from './client.ts'

interface Sent {
  url: string
  headers: Headers
  body: unknown
}

function stubApi(status: number, body: unknown): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      })
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }),
  )
  return sent
}

async function refusal(accessor: TavilyAccessor): Promise<unknown> {
  try {
    await tavilyRequest(accessor, 'POST', 'search', {})
  } catch (error) {
    return error
  }
  throw new Error('expected the call to fail')
}

// Mirrors python's tests/core/tavily/test_client.py.
describe('tavily client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the key and names mirage its source', async () => {
    const sent = stubApi(200, { results: [] })
    const answer = await tavilyRequest(
      new TavilyAccessor({ apiKey: 'tvly-k' }),
      'POST',
      'search',
      { query: 'q' },
      { clientName: 'me' },
    )
    expect(answer).toEqual({ results: [] })
    expect(sent[0]?.url).toBe('https://api.tavily.com/search')
    expect(sent[0]?.body).toEqual({ query: 'q' })
    expect(sent[0]?.headers.get('Authorization')).toBe('Bearer tvly-k')
    expect(sent[0]?.headers.get('X-Client-Source')).toBe('mirage')
    expect(sent[0]?.headers.get('X-Client-Name')).toBe('me')
    expect(sent[0]?.headers.has('X-Tavily-Access-Mode')).toBe(false)
  })

  it('says keyless instead of sending a key', async () => {
    const sent = stubApi(200, {})
    await tavilyRequest(new TavilyAccessor({}), 'POST', 'search', { query: 'q' })
    expect(sent[0]?.headers.has('Authorization')).toBe(false)
    expect(sent[0]?.headers.get('X-Tavily-Access-Mode')).toBe('keyless')
    expect(sent[0]?.headers.get('X-Client-Source')).toBe('mirage-keyless')
  })

  it.each([
    [{ detail: { error: 'Invalid API key' } }, 'Invalid API key'],
    [{ error: { message: 'slow down' } }, 'slow down'],
    [{ oops: 1 }, '500 Error: {"oops":1}'],
  ])('carries the message the SDK reads from %j', async (body, message) => {
    stubApi(500, body)
    const error = await refusal(new TavilyAccessor({ apiKey: 'tvly-k' }))
    expect(error).toBeInstanceOf(TavilyAPIError)
    expect((error as TavilyAPIError).message).toBe(message)
    expect((error as TavilyAPIError).status).toBe(500)
  })

  it('refuses with the keyless envelope as its own error', async () => {
    stubApi(429, {
      error: {
        code: 'keyless_cap',
        message: 'Daily cap reached',
        next_actions: [{ type: 'signup' }],
        retry_after_seconds: 90,
      },
    })
    const error = await refusal(new TavilyAccessor({}))
    expect(error).toBeInstanceOf(TavilyKeylessLimit)
    expect((error as TavilyKeylessLimit).message).toBe('Daily cap reached')
    expect((error as TavilyKeylessLimit).error.retry_after_seconds).toBe(90)
  })

  it('words a call that never connects as the SDK does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('refused'))),
    )
    const error = await refusal(new TavilyAccessor({ apiKey: 'tvly-k' }))
    expect(error).toBeInstanceOf(TavilyUnanswered)
    expect((error as TavilyUnanswered).message).toBe(
      'An unexpected error occurred while making the request. Error: TypeError: refused',
    )
  })

  it("prints the socket error fetch carries as its cause, as tvly's Node client does", async () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:59999')
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed', { cause }))),
    )
    const error = await refusal(new TavilyAccessor({ apiKey: 'tvly-k' }))
    expect((error as TavilyUnanswered).message).toBe(
      'An unexpected error occurred while making the request. ' +
        'Error: Error: connect ECONNREFUSED 127.0.0.1:59999',
    )
  })

  it.each([1.0625, 1e10, Infinity])('sends a call whose budget is %s seconds', async (budget) => {
    const sent = stubApi(200, {})
    await tavilyRequest(
      new TavilyAccessor({ apiKey: 'tvly-k' }),
      'POST',
      'crawl',
      {},
      {
        timeout: budget,
      },
    )
    expect(sent).toHaveLength(1)
  })

  it("gives a body without a timeout the verb's default", () => {
    expect(timedBody({ urls: ['u'] }, 30)).toEqual([{ urls: ['u'], timeout: 30 }, 30])
  })

  it('keeps a timeout the line gave where it is', () => {
    expect(timedBody({ timeout: 5, urls: ['u'] }, 30)).toEqual([{ timeout: 5, urls: ['u'] }, 5])
  })
})
