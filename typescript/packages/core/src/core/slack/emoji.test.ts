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
import { listEmoji } from './emoji.ts'

class FakeTransport implements SlackTransport {
  public endpoints: string[] = []
  constructor(private readonly response: SlackResponse) {}
  call(endpoint: string): Promise<SlackResponse> {
    this.endpoints.push(endpoint)
    return Promise.resolve(this.response)
  }
}

describe('listEmoji', () => {
  it('GETs emoji.list and returns the mapping', async () => {
    const t = new FakeTransport({ ok: true, emoji: { shipit: 'https://emoji/shipit.png' } })
    expect(await listEmoji(new SlackAccessor(t))).toEqual({ shipit: 'https://emoji/shipit.png' })
    expect(t.endpoints).toEqual(['emoji.list'])
  })

  it('tolerates a missing emoji key', async () => {
    const t = new FakeTransport({ ok: true })
    expect(await listEmoji(new SlackAccessor(t))).toEqual({})
  })
})
