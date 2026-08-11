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
import { DiscordAccessor } from '../../accessor/discord.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { dateToSnowflake, DISCORD_EPOCH, fetchRecentMessages, getHistoryJsonl } from './history.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(
    private readonly responder: (
      n: number,
      params?: Record<string, string | number>,
    ) => DiscordResponse,
  ) {}
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    this.calls.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder(this.calls.length, params))
  }
}

describe('dateToSnowflake', () => {
  it('produces a larger snowflake at end-of-day than at start', () => {
    const start = BigInt(dateToSnowflake('2026-04-25'))
    const end = BigInt(dateToSnowflake('2026-04-25', true))
    expect(end > start).toBe(true)
  })

  it('matches the (ms - epoch) << 22 formula', () => {
    const startMs = BigInt(Date.UTC(2026, 3, 25, 0, 0, 0))
    const expected = ((startMs - DISCORD_EPOCH) << 22n).toString()
    expect(dateToSnowflake('2026-04-25')).toBe(expected)
  })

  it('throws on malformed dates', () => {
    expect(() => dateToSnowflake('invalid')).toThrow()
    expect(() => dateToSnowflake('2026-04')).toThrow()
    expect(() => dateToSnowflake('abcd-ef-gh')).toThrow()
  })
})

describe('getHistoryJsonl', () => {
  it('paginates until a short batch is returned', async () => {
    // Discord answers newest-first, so a full page is descending and the
    // cursor for the next one is its first (newest) id.
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      id: String(BigInt(dateToSnowflake('2026-04-25')) + BigInt(100 - i)),
      content: `msg${String(100 - i)}`,
    }))
    const secondPage = [
      {
        id: String(BigInt(dateToSnowflake('2026-04-25')) + 200n),
        content: 'tail',
      },
    ]
    const t = new FakeDiscordTransport((n) => {
      if (n === 1) return firstPage
      if (n === 2) return secondPage
      return []
    })
    const out = await getHistoryJsonl(new DiscordAccessor(t), 'C1', '2026-04-25')
    expect(t.calls.length).toBe(2)
    expect(t.calls[0]?.endpoint).toBe('/channels/C1/messages')
    expect(t.calls[0]?.params).toMatchObject({ limit: 100 })
    expect(t.calls[1]?.params?.after).toBe(firstPage[0]?.id)
    const text = new TextDecoder().decode(out)
    const lines = text.trimEnd().split('\n')
    expect(lines.length).toBe(101)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('filters out messages whose id is past the end-of-day snowflake', async () => {
    const beforeBig = BigInt(dateToSnowflake('2026-04-25', true))
    const inside = { id: String(beforeBig - 10n), content: 'in' }
    const outside = { id: String(beforeBig + 10n), content: 'out' }
    const t = new FakeDiscordTransport((n) => {
      if (n === 1) return [inside, outside]
      return []
    })
    const out = await getHistoryJsonl(new DiscordAccessor(t), 'C1', '2026-04-25')
    const text = new TextDecoder().decode(out)
    expect(text).toContain('"in"')
    expect(text).not.toContain('"out"')
  })

  it('returns empty Uint8Array when there are no messages', async () => {
    const t = new FakeDiscordTransport(() => [])
    const out = await getHistoryJsonl(new DiscordAccessor(t), 'C1', '2026-04-25')
    expect(out).toBeInstanceOf(Uint8Array)
    expect(out.length).toBe(0)
  })

  it('sorts messages ascending by snowflake id across pages', async () => {
    const after = BigInt(dateToSnowflake('2026-04-25'))
    const m1 = { id: String(after + 5n), content: 'a' }
    const m2 = { id: String(after + 3n), content: 'b' }
    const t = new FakeDiscordTransport((n) => {
      if (n === 1) return [m1, m2]
      return []
    })
    const out = await getHistoryJsonl(new DiscordAccessor(t), 'C1', '2026-04-25')
    const lines = new TextDecoder().decode(out).trimEnd().split('\n')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ content: 'b' })
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ content: 'a' })
  })

  it('breaks when the response is null', async () => {
    const t = new FakeDiscordTransport(() => null)
    const out = await getHistoryJsonl(new DiscordAccessor(t), 'C1', '2026-04-25')
    expect(out.length).toBe(0)
  })
})

describe('fetchRecentMessages', () => {
  it('fetches one page and sorts oldest-first', async () => {
    const t = new FakeDiscordTransport(() => [{ id: '30' }, { id: '10' }, { id: '20' }])
    const messages = await fetchRecentMessages(new DiscordAccessor(t), 'C1', 3)
    expect(messages.map((m) => m.id)).toEqual(['10', '20', '30'])
  })
})
