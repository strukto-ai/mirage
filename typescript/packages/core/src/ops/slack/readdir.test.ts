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

import { mountKey } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { SlackAccessor } from '../../accessor/slack.ts'
import type { SlackResponse, SlackTransport } from '../../core/slack/_client.ts'
import { PathSpec, ResourceName } from '../../types.ts'
import { readdirOp } from './readdir.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: () => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder())
  }
}

describe('ops/slack/readdir', () => {
  it('is registered against ResourceName.SLACK as a non-write readdir op', () => {
    expect(readdirOp.name).toBe('readdir')
    expect(readdirOp.resource).toBe(ResourceName.SLACK)
    expect(readdirOp.write).toBe(false)
    expect(readdirOp.filetype).toBeNull()
  })

  it('dispatches to coreReaddir using the resource accessor', async () => {
    const t = new FakeTransport(() => ({ ok: true }))
    const accessor = new SlackAccessor(t)
    const out = await readdirOp.fn(
      accessor,
      new PathSpec({
        virtual: '/mnt/slack',
        directory: '/mnt/slack',
        resourcePath: mountKey('/mnt/slack', '/mnt/slack'),
      }),
      [],
      {},
    )
    expect(out).toEqual(['/mnt/slack/channels', '/mnt/slack/dms', '/mnt/slack/users'])
  })
})
