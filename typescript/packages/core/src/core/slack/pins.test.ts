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
import { listPins, pinMessage, unpinMessage } from './pins.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string>; body?: unknown }[] =
    []
  constructor(private readonly response: SlackResponse = { ok: true }) {}
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse> {
    this.calls.push({
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.response)
  }
}

describe('pins', () => {
  it('pinMessage POSTs pins.add', async () => {
    const t = new FakeTransport()
    await pinMessage(new SlackAccessor(t), 'C1', '1.0')
    expect(t.calls[0]?.endpoint).toBe('pins.add')
    expect(t.calls[0]?.body).toEqual({ channel: 'C1', timestamp: '1.0' })
  })

  it('unpinMessage POSTs pins.remove', async () => {
    const t = new FakeTransport()
    await unpinMessage(new SlackAccessor(t), 'C1', '1.0')
    expect(t.calls[0]?.endpoint).toBe('pins.remove')
  })

  it('listPins returns items and tolerates a missing key', async () => {
    const withItems = new FakeTransport({ ok: true, items: [{ type: 'message' }] })
    expect(await listPins(new SlackAccessor(withItems), 'C1')).toEqual([{ type: 'message' }])
    expect(withItems.calls[0]?.params).toEqual({ channel: 'C1' })
    const without = new FakeTransport({ ok: true })
    expect(await listPins(new SlackAccessor(without), 'C1')).toEqual([])
  })
})
