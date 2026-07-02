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
import type {
  DiscordMethod,
  DiscordResponse,
  DiscordTransport,
} from '../../core/discord/_client.ts'
import { PathSpec, ResourceName } from '../../types.ts'
import { readdirOp } from './readdir.ts'

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

describe('ops/discord/readdir', () => {
  it('is registered against ResourceName.DISCORD as a non-write readdir op', () => {
    expect(readdirOp.name).toBe('readdir')
    expect(readdirOp.resource).toBe(ResourceName.DISCORD)
    expect(readdirOp.write).toBe(false)
    expect(readdirOp.filetype).toBeNull()
  })

  it('dispatches to coreReaddir using the resource accessor', async () => {
    const t = new FakeDiscordTransport((_m, endpoint) => {
      if (endpoint === '/users/@me/guilds') {
        return [{ id: 'G1', name: 'My Server' }]
      }
      return null
    })
    const accessor = new DiscordAccessor(t)
    const out = (await readdirOp.fn(
      accessor,
      new PathSpec({
        virtual: '/mnt/discord',
        directory: '/mnt/discord',
        resourcePath: mountKey('/mnt/discord', '/mnt/discord'),
      }),
      [],
      {},
    )) as string[]
    expect(out).toEqual(['/mnt/discord/My Server__G1'])
    const endpoints = t.calls.map((c) => c.endpoint)
    expect(endpoints).toContain('/users/@me/guilds')
  })
})
