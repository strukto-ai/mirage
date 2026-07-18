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
import { DiscordAccessor } from '../../accessor/discord.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type {
  DiscordMethod,
  DiscordResponse,
  DiscordTransport,
} from '../../core/discord/_client.ts'
import { type FileStat, FileType, PathSpec, ResourceName } from '../../types.ts'
import { DISCORD_OPS } from './index.ts'

const statOp = DISCORD_OPS.find((o) => o.name === 'stat' && o.filetype === null)
if (!statOp) throw new Error('discord stat op not registered')

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: { method: DiscordMethod; endpoint: string }[] = []
  constructor(private readonly responder: () => DiscordResponse = () => null) {}
  call(method: DiscordMethod, endpoint: string): Promise<DiscordResponse> {
    this.calls.push({ method, endpoint })
    return Promise.resolve(this.responder())
  }
}

describe('ops/discord/stat', () => {
  it('is registered against ResourceName.DISCORD as a non-write stat op', () => {
    expect(statOp.name).toBe('stat')
    expect(statOp.resource).toBe(ResourceName.DISCORD)
    expect(statOp.write).toBe(false)
    expect(statOp.filetype).toBeNull()
  })

  it('dispatches to coreStat using the resource accessor', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord/My Server__G1/channels', [
      [
        'general__C1',
        new IndexEntry({
          id: 'C1',
          name: 'general',
          resourceType: 'discord/channel',
          vfsName: 'general__C1',
          remoteTime: '0',
        }),
      ],
    ])
    const t = new FakeDiscordTransport()
    const accessor = new DiscordAccessor(t)
    const out = (await statOp.fn(
      accessor,
      new PathSpec({
        virtual: '/mnt/discord/My Server__G1/channels/general__C1',
        directory: '/mnt/discord/My Server__G1/channels/general__C1',
        resourcePath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      }),
      [],
      { index: idx },
    )) as FileStat
    expect(out.type).toBe(FileType.DIRECTORY)
    expect(out.name).toBe('general__C1')
    expect(out.extra.channel_id).toBe('C1')
  })
})
