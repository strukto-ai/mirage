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

const DISCORD_CAT = DISCORD_COMMANDS.filter((c) => c.name === 'cat' && c.filetype == null)

const DEC = new TextDecoder()

async function runCat(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  options: { index?: RAMIndexCacheStore; transport?: FakeDiscordTransport } = {},
): Promise<string> {
  const cmd = DISCORD_CAT[0]
  if (cmd === undefined) throw new Error('cat not registered')
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

describe('discord cat', () => {
  it('reads jsonl content from a 4-level VFS path', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2024-01-01'],
    })
    const transport = new FakeDiscordTransport((_method, endpoint) => {
      if (endpoint === '/channels/C1/messages') {
        return [
          { id: '175928847299117056', content: 'hello' },
          { id: '175928847299117057', content: 'world' },
        ]
      }
      return null
    })
    const out = await runCat(
      [
        new PathSpec({
          original: '/mnt/discord/My Server__G1/channels/general__C1/2016-04-30/chat.jsonl',
          directory: '/mnt/discord/My Server__G1/channels/general__C1/',
          resolved: false,
          prefix: '/mnt/discord',
        }),
      ],
      {},
      { index: idx, transport },
    )
    const lines = out.trimEnd().split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const first = JSON.parse(lines[0] ?? '{}') as { content?: string }
    expect(first.content).toBe('hello')
  })

  it('returns numbered output with -n', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2024-01-01'],
    })
    const transport = new FakeDiscordTransport((_method, endpoint) => {
      if (endpoint === '/channels/C1/messages') {
        return [{ id: '175928847299117056', content: 'hi' }]
      }
      return null
    })
    const out = await runCat(
      [
        new PathSpec({
          original: '/mnt/discord/My Server__G1/channels/general__C1/2016-04-30/chat.jsonl',
          directory: '/mnt/discord/My Server__G1/channels/general__C1/',
          resolved: false,
          prefix: '/mnt/discord',
        }),
      ],
      { n: true },
      { index: idx, transport },
    )
    expect(out.startsWith('     1\t')).toBe(true)
  })
})
