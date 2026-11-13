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
import { DiscordAccessor } from './discord.ts'
import type { DiscordMethod, DiscordTransport } from '../core/discord/client.ts'

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: {
    method: DiscordMethod
    endpoint: string
    params?: Record<string, string | number>
    body?: Record<string, unknown>
  }[] = []
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
    return Promise.resolve(null)
  }
}

describe('DiscordAccessor', () => {
  it('exposes the transport unchanged', () => {
    const t = new FakeDiscordTransport()
    const a = new DiscordAccessor(t)
    expect(a.transport).toBe(t)
  })

  it('relays calls through transport.call', async () => {
    const t = new FakeDiscordTransport()
    const a = new DiscordAccessor(t)
    await a.transport.call('GET', '/users/@me/guilds')
    expect(t.calls).toEqual([{ method: 'GET', endpoint: '/users/@me/guilds' }])
  })
})
