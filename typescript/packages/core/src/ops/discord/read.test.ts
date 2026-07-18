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
import { PathSpec, ResourceName } from '../../types.ts'
import { DISCORD_VFS_OPS } from './index.ts'

const readOp = DISCORD_VFS_OPS.find((o) => o.name === 'read' && o.filetype === null)
if (!readOp) throw new Error('discord read op not registered')

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: { method: DiscordMethod; endpoint: string }[] = []
  constructor(
    private readonly responder: (method: DiscordMethod, endpoint: string) => DiscordResponse = () =>
      null,
  ) {}
  call(method: DiscordMethod, endpoint: string): Promise<DiscordResponse> {
    this.calls.push({ method, endpoint })
    return Promise.resolve(this.responder(method, endpoint))
  }
}

describe('ops/discord/read', () => {
  it('is registered against ResourceName.DISCORD as a non-write read op', () => {
    expect(readOp.name).toBe('read')
    expect(readOp.resource).toBe(ResourceName.DISCORD)
    expect(readOp.write).toBe(false)
    expect(readOp.filetype).toBeNull()
  })

  it('dispatches to coreRead using the resource accessor', async () => {
    const idx = new RAMIndexCacheStore()
    await idx.setDir('/mnt/discord', [
      [
        'My Server__G1',
        new IndexEntry({
          id: 'G1',
          name: 'My Server',
          resourceType: 'discord/guild',
          vfsName: 'My Server__G1',
        }),
      ],
    ])
    await idx.setDir('/mnt/discord/My Server__G1/members', [
      [
        'alice__U1.json',
        new IndexEntry({
          id: 'U1',
          name: 'alice',
          resourceType: 'discord/member',
          vfsName: 'alice__U1.json',
        }),
      ],
    ])
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/guilds/G1/members') {
        return [{ user: { id: 'U1', username: 'alice' }, nick: 'Alice' }]
      }
      return null
    })
    const accessor = new DiscordAccessor(t)
    const out = (await readOp.fn(
      accessor,
      new PathSpec({
        virtual: '/mnt/discord/My Server__G1/members/alice__U1.json',
        directory: '/mnt/discord/My Server__G1/members/alice__U1.json',
        resourcePath: mountKey('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
      }),
      [],
      { index: idx },
    )) as Uint8Array
    const parsed = JSON.parse(new TextDecoder().decode(out)) as Record<string, unknown>
    expect(parsed).toMatchObject({ user: { id: 'U1', username: 'alice' }, nick: 'Alice' })
    const memCall = t.calls.find((c) => c.endpoint === '/guilds/G1/members')
    expect(memCall).toBeDefined()
  })
})
