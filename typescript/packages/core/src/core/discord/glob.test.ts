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
import { PathSpec } from '../../types.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './client.ts'
import { makeResolveGlob } from '../../utils/glob_walk.ts'
import { mountDiscord } from '../../vfs/discord/_test_util.ts'
import { rowsOf } from '../hierarchy/probe.ts'
import { readdir as discordReaddir } from './readdir.ts'

async function listedPaths(accessor: DiscordAccessor, path: PathSpec): Promise<string[]> {
  const base = path.virtual.replace(/\/$/, '')
  return rowsOf(await discordReaddir(accessor, path)).map((row) => `${base}/${row.name}`)
}

const resolveDiscordGlob = makeResolveGlob(listedPaths)

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

describe('resolveDiscordGlob', () => {
  it('passes through resolved PathSpec unchanged', async () => {
    const t = new FakeDiscordTransport()
    const resolved = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
      directory: '/mnt/discord/My Server__G1/channels/general__C1/',
      vfsPath: mountKey(
        '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
        '/mnt/discord',
      ),
      resolved: true,
    })
    const out = await resolveDiscordGlob(new DiscordAccessor(t), [resolved])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(resolved)
    expect(t.calls).toHaveLength(0)
  })

  it('passes through unresolved PathSpec with no pattern unchanged', async () => {
    const t = new FakeDiscordTransport()
    const noPattern = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1',
      directory: '/mnt/discord/My Server__G1/channels/general__C1',
      vfsPath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      resolved: false,
    })
    const out = await resolveDiscordGlob(new DiscordAccessor(t), [noPattern])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(noPattern)
    expect(t.calls).toHaveLength(0)
  })
})

describe('a glob through a mount', () => {
  it("matches a channel's days by their names", async () => {
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/users/@me/guilds') return [{ id: 'G1', name: 'srv' }]
      if (endpoint === '/guilds/G1/channels') {
        return [{ id: 'C1', name: 'general', type: 0, last_message_id: '175928847299117056' }]
      }
      return null
    })
    const ws = mountDiscord(t)
    try {
      const result = await ws.shell('echo /mnt/discord/srv__G1/channels/general__C1/2016-04-2*')
      const days = result.stdoutText.split(/\s+/).filter((w) => w !== '')
      expect(days).toHaveLength(10)
      expect(days[0]).toBe('/mnt/discord/srv__G1/channels/general__C1/2016-04-20')
    } finally {
      await ws.close()
    }
  })
})
