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
import type { DiscordMethod, DiscordTransport } from './client.ts'
import { listChannels } from './channels.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(private readonly responder: () => unknown = () => null) {}
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder())
  }
}

describe('listChannels', () => {
  it('GETs /guilds/<id>/channels and filters to text-like types', async () => {
    const t = new FakeDiscordTransport(() => [
      { id: 'C1', name: 'general', type: 0 },
      { id: 'C2', name: 'voice', type: 2 },
      { id: 'C3', name: 'announcements', type: 5 },
    ])
    const out = await listChannels(new DiscordAccessor(t), 'G1')
    expect(t.calls[0]?.method).toBe('GET')
    expect(t.calls[0]?.endpoint).toBe('/guilds/G1/channels')
    expect(out.map((c) => c.id)).toEqual(['C1', 'C3'])
  })

  it('drops channels whose type is undefined', async () => {
    const t = new FakeDiscordTransport(() => [{ id: 'C1', name: 'mystery' }])
    const out = await listChannels(new DiscordAccessor(t), 'G1')
    expect(out).toEqual([])
  })

  it('returns empty array on non-array response', async () => {
    const t = new FakeDiscordTransport(() => null)
    const out = await listChannels(new DiscordAccessor(t), 'G1')
    expect(out).toEqual([])
  })
})
