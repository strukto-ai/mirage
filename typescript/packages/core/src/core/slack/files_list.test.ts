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
import { listFilesForDay, listFilesForDayStream } from './files_list.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: (call: number) => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length))
  }
}

describe('listFilesForDayStream', () => {
  it('calls files.list with channel + ts_from/ts_to + count', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      files: [{ id: 'F1', name: 'a.pdf' }],
      paging: { pages: 1 },
    }))
    const pages: { id: string }[][] = []
    for await (const page of listFilesForDayStream(new SlackAccessor(t), 'C1', '2026-04-04')) {
      pages.push(page as { id: string }[])
    }
    expect(pages).toEqual([[{ id: 'F1', name: 'a.pdf' }]])
    expect(t.calls[0]?.endpoint).toBe('files.list')
    expect(t.calls[0]?.params).toMatchObject({ channel: 'C1', count: '200' })
    expect(t.calls[0]?.params?.ts_from).toBeDefined()
    expect(t.calls[0]?.params?.ts_to).toBeDefined()
  })

  it('walks multi-page responses', async () => {
    const pages: SlackResponse[] = [
      { ok: true, files: [{ id: 'F1' }], paging: { pages: 2 } },
      { ok: true, files: [{ id: 'F2' }], paging: { pages: 2 } },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const ids: string[] = []
    for await (const page of listFilesForDayStream(new SlackAccessor(t), 'C1', '2026-04-04')) {
      for (const f of page) ids.push((f as { id: string }).id)
    }
    expect(ids).toEqual(['F1', 'F2'])
    expect(t.calls[0]?.params?.page).toBe('1')
    expect(t.calls[1]?.params?.page).toBe('2')
  })
})

describe('listFilesForDay (eager wrapper)', () => {
  it('flattens all pages', async () => {
    const pages: SlackResponse[] = [
      { ok: true, files: [{ id: 'F1' }, { id: 'F2' }], paging: { pages: 2 } },
      { ok: true, files: [{ id: 'F3' }], paging: { pages: 2 } },
    ]
    const t = new FakeTransport((call) => pages[call - 1] ?? { ok: false })
    const files = await listFilesForDay(new SlackAccessor(t), 'C1', '2026-04-04')
    expect(files.map((f) => f.id)).toEqual(['F1', 'F2', 'F3'])
  })
})
