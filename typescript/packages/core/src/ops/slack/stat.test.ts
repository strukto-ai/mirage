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
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { SlackResponse, SlackTransport } from '../../core/slack/_client.ts'
import { type FileStat, FileType, PathSpec, ResourceName } from '../../types.ts'
import { statOp } from './stat.ts'

class FakeTransport implements SlackTransport {
  public readonly calls: { endpoint: string; params?: Record<string, string> }[] = []
  constructor(private readonly responder: () => SlackResponse) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push({ endpoint, ...(params !== undefined ? { params } : {}) })
    return Promise.resolve(this.responder())
  }
}

describe('ops/slack/stat', () => {
  it('is registered against ResourceName.SLACK as a non-write stat op', () => {
    expect(statOp.name).toBe('stat')
    expect(statOp.resource).toBe(ResourceName.SLACK)
    expect(statOp.write).toBe(false)
    expect(statOp.filetype).toBeNull()
  })

  it('dispatches to coreStat using the resource accessor', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/slack/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'slack/channel',
          vfsName: 'general__C1',
          remoteTime: '0',
        }),
      ],
    ])
    const t = new FakeTransport(() => ({ ok: true }))
    const accessor = new SlackAccessor(t)
    const out = (await statOp.fn(
      accessor,
      new PathSpec({
        virtual: '/mnt/slack/channels/general__C1',
        directory: '/mnt/slack/channels/general__C1',
        resourcePath: mountKey('/mnt/slack/channels/general__C1', '/mnt/slack'),
      }),
      [],
      { index: idx },
    )) as FileStat
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__C1')
    expect(out.extra.channel_id).toBe('C1')
  })
})
