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
import { getHistoryJsonl } from './history.ts'
import { SlackAccessor } from '../../accessor/slack.ts'
import type { SlackResponse, SlackTransport } from './_client.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(
    private readonly responder: (call: number, params?: Record<string, string>) => SlackResponse,
  ) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder(this.calls.length, params))
  }
}

const decoder = new TextDecoder()

describe('getHistoryJsonl', () => {
  it('returns JSONL bytes with one message per line, trailing newline', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      messages: [
        { ts: '1700000010.0', user: 'U1', text: 'hi' },
        { ts: '1700000020.0', user: 'U2', text: 'yo' },
      ],
      has_more: false,
    }))
    const bytes = await getHistoryJsonl(new SlackAccessor(t), 'C1', '2026-04-24')
    const text = decoder.decode(bytes)
    expect(text.endsWith('\n')).toBe(true)
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ts: '1700000010.0', user: 'U1' })
  })

  it('sorts messages by ts (numeric ascending)', async () => {
    const t = new FakeTransport(() => ({
      ok: true,
      messages: [
        { ts: '1700000020.0', text: 'second' },
        { ts: '1700000010.0', text: 'first' },
      ],
      has_more: false,
    }))
    const bytes = await getHistoryJsonl(new SlackAccessor(t), 'C1', '2026-04-24')
    const lines = decoder.decode(bytes).trim().split('\n')
    expect((JSON.parse(lines[0] ?? '') as { text: string }).text).toBe('first')
    expect((JSON.parse(lines[1] ?? '') as { text: string }).text).toBe('second')
  })

  it('returns empty bytes when no messages', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: [], has_more: false }))
    const bytes = await getHistoryJsonl(new SlackAccessor(t), 'C1', '2026-04-24')
    expect(bytes.length).toBe(0)
  })

  it('paginates when has_more is true', async () => {
    let calls = 0
    const t = new FakeTransport((n) => {
      calls = n
      if (n === 1) {
        return {
          ok: true,
          messages: [{ ts: '1.0', text: 'a' }],
          has_more: true,
          response_metadata: { next_cursor: 'c2' },
        }
      }
      return { ok: true, messages: [{ ts: '2.0', text: 'b' }], has_more: false }
    })
    const bytes = await getHistoryJsonl(new SlackAccessor(t), 'C1', '2026-04-24')
    expect(calls).toBe(2)
    expect(t.calls[1]?.params?.cursor).toBe('c2')
    const lines = decoder.decode(bytes).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('sends correct oldest/latest from date_str (UTC start/end-of-day)', async () => {
    const t = new FakeTransport(() => ({ ok: true, messages: [], has_more: false }))
    await getHistoryJsonl(new SlackAccessor(t), 'C1', '2026-04-24')
    const params = t.calls[0]?.params
    expect(params).toBeDefined()
    expect(params?.channel).toBe('C1')
    expect(params?.inclusive).toBe('true')
    expect(params?.limit).toBe('200')
    expect(Math.floor(Number(params?.oldest))).toBe(1776988800)
    expect(Math.floor(Number(params?.latest))).toBe(1777075199)
  })

  it('breaks pagination when has_more=true but next_cursor is empty', async () => {
    let calls = 0
    const t = new FakeTransport((n) => {
      calls = n
      return {
        ok: true,
        messages: [{ ts: '1.0' }],
        has_more: true,
        response_metadata: { next_cursor: '' },
      }
    })
    await getHistoryJsonl(new SlackAccessor(t), 'C1', '2026-04-24')
    expect(calls).toBe(1)
  })
})
