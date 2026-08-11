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
import type { DiscordMethod, DiscordTransport } from './_client.ts'
import { createThread } from './threads.ts'

class FakeTransport implements DiscordTransport {
  public readonly calls: { method: DiscordMethod; endpoint: string; body?: unknown }[] = []
  call(
    method: DiscordMethod,
    endpoint: string,
    _params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    this.calls.push({ method, endpoint, ...(body !== undefined ? { body } : {}) })
    return Promise.resolve({ id: 'T1' })
  }
}

describe('createThread', () => {
  it('creates from a message when messageId is given', async () => {
    const t = new FakeTransport()
    await createThread(new DiscordAccessor(t), 'C1', 'topic', 'M1')
    expect(t.calls[0]).toEqual({
      method: 'POST',
      endpoint: '/channels/C1/messages/M1/threads',
      body: { name: 'topic' },
    })
  })

  it('creates standalone without a messageId', async () => {
    const t = new FakeTransport()
    await createThread(new DiscordAccessor(t), 'C1', 'topic')
    expect(t.calls[0]?.endpoint).toBe('/channels/C1/threads')
    expect(t.calls[0]?.body).toEqual({ name: 'topic', type: 11 })
  })
})
