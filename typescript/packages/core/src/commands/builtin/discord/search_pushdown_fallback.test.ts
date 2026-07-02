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

import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { DiscordApiError, type DiscordTransport } from '../../../core/discord/_client.ts'
import { PathSpec } from '../../../types.ts'
import { DISCORD_GREP } from './grep.ts'
import { DISCORD_RG } from './rg.ts'
import { makeFakeResource, seedChannel, seedGuild } from './_test_util.ts'

const DEC = new TextDecoder()

function failingSearchTransport(status: number, message: string): DiscordTransport {
  return {
    call: (_method, endpoint): Promise<unknown> => {
      if (endpoint.includes('/messages/search')) {
        return Promise.reject(new DiscordApiError(endpoint, status, message))
      }
      return Promise.resolve([])
    },
  }
}

async function setupChannel(idx: RAMIndexCacheStore): Promise<void> {
  await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
  await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
    dates: ['2026-01-01'],
  })
}

describe('discord grep push-down fallback', () => {
  it('emits READ_MESSAGE_HISTORY hint on 403 and falls back', async () => {
    const idx = new RAMIndexCacheStore()
    await setupChannel(idx)
    const transport = failingSearchTransport(403, 'Missing Permissions')
    const resource = makeFakeResource(transport)
    const grep = DISCORD_GREP[0]
    if (grep === undefined) throw new Error('grep not registered')
    const result = await grep.fn(
      resource.accessor,
      [
        new PathSpec({
          virtual: '/mnt/discord/My Server__G1/channels/general__C1',
          directory: '/mnt/discord/My Server__G1/channels/general__C1',
          resolved: false,
          resourcePath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
        }),
      ],
      ['hi'],
      {
        stdin: null,
        flags: { args_l: true },
        filetypeFns: null,
        cwd: '/',
        resource,
        index: idx,
      },
    )
    if (result === null) throw new Error('expected a result tuple')
    const [, io] = result
    const stderr = io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : ''
    expect(stderr).toContain('push-down failed')
    expect(stderr).toContain('READ_MESSAGE_HISTORY')
  })
})

describe('discord rg push-down fallback', () => {
  it('emits warning on rate-limit and falls back without hint', async () => {
    const idx = new RAMIndexCacheStore()
    await setupChannel(idx)
    const transport = failingSearchTransport(429, 'rate_limited')
    const resource = makeFakeResource(transport)
    const rg = DISCORD_RG[0]
    if (rg === undefined) throw new Error('rg not registered')
    const result = await rg.fn(
      resource.accessor,
      [
        new PathSpec({
          virtual: '/mnt/discord/My Server__G1/channels/general__C1',
          directory: '/mnt/discord/My Server__G1/channels/general__C1',
          resolved: false,
          resourcePath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
        }),
      ],
      ['hi'],
      {
        stdin: null,
        flags: {},
        filetypeFns: null,
        cwd: '/',
        resource,
        index: idx,
      },
    )
    if (result === null) throw new Error('expected a result tuple')
    const [, io] = result
    const stderr = io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : ''
    expect(stderr).toContain('push-down failed')
    expect(stderr).not.toContain('READ_MESSAGE_HISTORY')
  })
})
