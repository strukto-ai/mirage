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
import type { SlackResponse, SlackTransport } from './_client.ts'
import { cursorPages, offsetPages } from './paginate.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (call: number) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length))
  }
}

describe('cursorPages', () => {
  it('walks until empty cursor', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        items: [1, 2],
        response_metadata: { next_cursor: 'cur1' },
      },
      {
        ok: true,
        items: [3],
        response_metadata: { next_cursor: '' },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const result: number[][] = []
    for await (const page of cursorPages<number>(
      t,
      'conversations.list',
      { types: 'x', limit: '100' },
      'items',
    )) {
      result.push(page)
    }
    expect(result).toEqual([[1, 2], [3]])
    expect(t.calls[0]?.params).toEqual({ types: 'x', limit: '100' })
    expect(t.calls[1]?.params).toEqual({ types: 'x', limit: '100', cursor: 'cur1' })
  })

  it('terminates without further calls after caller breaks', async () => {
    const pages: SlackResponse[] = [
      { ok: true, items: [1], response_metadata: { next_cursor: 'cur1' } },
      { ok: true, items: [2], response_metadata: { next_cursor: 'cur2' } },
      { ok: true, items: [3], response_metadata: { next_cursor: '' } },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    for await (const page of cursorPages<number>(
      t,
      'conversations.list',
      { limit: '1' },
      'items',
    )) {
      expect(page).toEqual([1])
      break
    }
    expect(t.calls).toHaveLength(1)
  })

  it('yields an empty page when items key absent', async () => {
    const t = new FakeTransport(() => ({ ok: true, response_metadata: { next_cursor: '' } }))
    const result: unknown[][] = []
    for await (const page of cursorPages(t, 'users.list', { limit: '10' }, 'members')) {
      result.push(page)
    }
    expect(result).toEqual([[]])
  })
})

describe('offsetPages', () => {
  it('walks search.messages pagination', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        messages: {
          matches: [{ text: 'a' }],
          pagination: { page: 1, page_count: 2 },
        },
      },
      {
        ok: true,
        messages: {
          matches: [{ text: 'b' }],
          pagination: { page: 2, page_count: 2 },
        },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const result: { text: string }[][] = []
    for await (const page of offsetPages<{ text: string }>(
      t,
      'search.messages',
      { query: 'x', count: '100' },
      ['messages', 'pagination', 'page_count'],
      ['messages', 'matches'],
    )) {
      result.push(page)
    }
    expect(result).toEqual([[{ text: 'a' }], [{ text: 'b' }]])
    expect(t.calls[0]?.params?.page).toBe('1')
    expect(t.calls[1]?.params?.page).toBe('2')
  })

  it('stops at maxPages even when more pages exist', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      messages: {
        matches: [{ text: 'p' }],
        pagination: { page: 1, page_count: 10 },
      },
    }))
    const result: unknown[][] = []
    for await (const page of offsetPages(
      t,
      'search.messages',
      { query: 'x' },
      ['messages', 'pagination', 'page_count'],
      ['messages', 'matches'],
      { maxPages: 2 },
    )) {
      result.push(page)
    }
    expect(result).toHaveLength(2)
    expect(t.calls).toHaveLength(2)
  })

  it('defaults to 1 page when pages_path is missing', async () => {
    const t = new FakeTransport(() => ({ ok: true, files: ['a'] }))
    const result: unknown[][] = []
    for await (const page of offsetPages(t, 'files.list', {}, ['paging', 'pages'], ['files'])) {
      result.push(page)
    }
    expect(result).toEqual([['a']])
    expect(t.calls).toHaveLength(1)
  })
})
