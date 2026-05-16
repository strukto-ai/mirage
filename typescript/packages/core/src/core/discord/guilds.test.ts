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
import { listGuilds } from './guilds.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(private readonly responder: () => DiscordResponse = () => null) {}
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
    return Promise.resolve(this.responder())
  }
}

describe('listGuilds', () => {
  it('GETs /users/@me/guilds and returns the array', async () => {
    const t = new FakeDiscordTransport(() => [{ id: 'G1', name: 'My Server' }])
    const out = await listGuilds(new DiscordAccessor(t))
    expect(t.calls[0]?.method).toBe('GET')
    expect(t.calls[0]?.endpoint).toBe('/users/@me/guilds')
    expect(t.calls[0]?.params?.after).toBe('0')
    expect(t.calls[0]?.params?.limit).toBe(200)
    expect(t.calls[0]?.body).toBeUndefined()
    expect(out).toEqual([{ id: 'G1', name: 'My Server' }])
  })

  it('returns empty array when response is not an array', async () => {
    const t = new FakeDiscordTransport(() => null)
    const out = await listGuilds(new DiscordAccessor(t))
    expect(out).toEqual([])
  })
})
