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
import type { SlackResponse, SlackTransport } from './_client.ts'
import { searchFilesStream, searchMessagesStream } from './search.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (call: number) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length))
  }
}

describe('searchMessagesStream', () => {
  it('walks pages via offsetPages, yields matches per page', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        messages: {
          matches: [{ ts: '1', text: 'a' }],
          pagination: { page: 1, page_count: 2 },
        },
      },
      {
        ok: true,
        messages: {
          matches: [{ ts: '2', text: 'b' }],
          pagination: { page: 2, page_count: 2 },
        },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const result: { text: string }[][] = []
    for await (const page of searchMessagesStream(new SlackAccessor(t), 'hello')) {
      result.push(page as { text: string }[])
    }
    expect(result.flat().map((m) => m.text)).toEqual(['a', 'b'])
    expect(t.calls[0]?.endpoint).toBe('search.messages')
    expect(t.calls[0]?.params).toMatchObject({
      query: 'hello',
      count: '100',
      sort: 'timestamp',
      page: '1',
    })
    expect(t.calls[1]?.params?.page).toBe('2')
  })

  it('respects maxPages cap', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      messages: {
        matches: [{ ts: '1' }],
        pagination: { page: 1, page_count: 10 },
      },
    }))
    let count = 0
    for await (const _page of searchMessagesStream(new SlackAccessor(t), 'q', { maxPages: 2 })) {
      void _page
      count++
    }
    expect(count).toBe(2)
    expect(t.calls).toHaveLength(2)
  })
})

describe('searchFilesStream', () => {
  it('paginates search.files via files.pagination.page_count', async () => {
    const pages: SlackResponse[] = [
      {
        ok: true,
        files: {
          matches: [{ id: 'F1' }],
          pagination: { page: 1, page_count: 2 },
        },
      },
      {
        ok: true,
        files: {
          matches: [{ id: 'F2' }],
          pagination: { page: 2, page_count: 2 },
        },
      },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const ids: string[] = []
    for await (const page of searchFilesStream(new SlackAccessor(t), 'pdf')) {
      for (const f of page) ids.push((f as { id: string }).id)
    }
    expect(ids).toEqual(['F1', 'F2'])
    expect(t.calls[0]?.endpoint).toBe('search.files')
  })
})
