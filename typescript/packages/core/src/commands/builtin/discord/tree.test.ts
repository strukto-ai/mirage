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
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { FakeDiscordTransport, makeFakeResource, seedChannel, seedGuild } from './_test_util.ts'
import { DISCORD_COMMANDS } from './index.ts'

const DISCORD_TREE = DISCORD_COMMANDS.filter((c) => c.name === 'tree' && c.filetype == null)

const DEC = new TextDecoder()

async function runTree(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  options: { index?: RAMIndexCacheStore; transport?: FakeDiscordTransport } = {},
): Promise<string> {
  const cmd = DISCORD_TREE[0]
  if (cmd === undefined) throw new Error('tree not registered')
  const transport = options.transport ?? new FakeDiscordTransport()
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
    ...(options.index !== undefined ? { index: options.index } : {}),
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('discord tree', () => {
  it('renders depth-1 listing of a guild dir', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    const out = await runTree(
      [
        new PathSpec({
          original: '/mnt/discord/My Server__G1',
          directory: '/mnt/discord/My Server__G1',
          resolved: false,
          prefix: '/mnt/discord',
        }),
      ],
      { L: '1' },
      { index: idx },
    )
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('channels')
    expect(lines[1]).toContain('members')
  })

  it('descends into channels subtree from cached index', async () => {
    const idx = new RAMIndexCacheStore()
    const transport = new FakeDiscordTransport(() => {
      throw new Error('should not be called')
    })
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2024-01-01'],
    })
    const out = await runTree(
      [
        new PathSpec({
          original: '/mnt/discord/My Server__G1/channels',
          directory: '/mnt/discord/My Server__G1/channels',
          resolved: false,
          prefix: '/mnt/discord',
        }),
      ],
      {},
      { index: idx, transport },
    )
    expect(out).toContain('general__C1')
    expect(out).toContain('2024-01-01')
  })
})
