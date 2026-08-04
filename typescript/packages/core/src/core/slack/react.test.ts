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
import { addReaction, getReactions } from './react.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string>; body?: unknown }[] =
    []
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse> {
    this.calls.push({
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve({ ok: true })
  }
}

describe('addReaction', () => {
  it('POSTs to reactions.add with channel, timestamp, name', async () => {
    const t = new FakeTransport()
    const out = await addReaction(new SlackAccessor(t), 'C1', '1.0', 'thumbsup')
    expect(t.calls[0]?.endpoint).toBe('reactions.add')
    expect(t.calls[0]?.params).toBeUndefined()
    expect(t.calls[0]?.body).toEqual({ channel: 'C1', timestamp: '1.0', name: 'thumbsup' })
    expect(out).toMatchObject({ ok: true })
  })
})

class ReactionsFake {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve({
      ok: true,
      message: { ts: '1.0', reactions: [{ name: 'shipit', count: 2 }] },
    })
  }
}

describe('getReactions', () => {
  it('GETs reactions.get and returns the message item', async () => {
    const t = new ReactionsFake()
    const message = await getReactions(new SlackAccessor(t as SlackTransport), 'C1', '1.0')
    expect(t.calls[0]?.endpoint).toBe('reactions.get')
    expect(t.calls[0]?.params).toEqual({ channel: 'C1', timestamp: '1.0' })
    expect(message).toEqual({ ts: '1.0', reactions: [{ name: 'shipit', count: 2 }] })
  })
})
