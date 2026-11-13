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
import { addReaction } from './react.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
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

describe('addReaction', () => {
  it('PUTs to the reaction endpoint with URL-encoded emoji', async () => {
    const t = new FakeDiscordTransport()
    await addReaction(new DiscordAccessor(t), 'C1', 'M1', '\u{1F44D}')
    expect(t.calls[0]?.method).toBe('PUT')
    expect(t.calls[0]?.endpoint).toBe('/channels/C1/messages/M1/reactions/%F0%9F%91%8D/@me')
    expect(t.calls[0]?.params).toBeUndefined()
    expect(t.calls[0]?.body).toBeUndefined()
  })

  it('encodes ASCII emoji shortcode-style strings', async () => {
    const t = new FakeDiscordTransport()
    await addReaction(new DiscordAccessor(t), 'C1', 'M1', 'name:123')
    expect(t.calls[0]?.endpoint).toBe('/channels/C1/messages/M1/reactions/name%3A123/@me')
  })
})
