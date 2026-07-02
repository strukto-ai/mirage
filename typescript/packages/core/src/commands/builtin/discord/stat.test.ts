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
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { FakeDiscordTransport, makeFakeResource, seedChannel, seedGuild } from './_test_util.ts'
import { DISCORD_COMMANDS } from './index.ts'

const DISCORD_STAT = DISCORD_COMMANDS.filter((c) => c.name === 'stat' && c.filetype == null)

const DEC = new TextDecoder()

async function runStat(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  options: { index?: RAMIndexCacheStore; transport?: FakeDiscordTransport } = {},
): Promise<{ stdout: string; exitCode: number }> {
  const cmd = DISCORD_STAT[0]
  if (cmd === undefined) throw new Error('stat not registered')
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
  if (result === null) return { stdout: '', exitCode: 0 }
  const [out, io] = result
  const buf =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  return { stdout: DEC.decode(buf), exitCode: io.exitCode }
}

describe('discord stat', () => {
  it('reports default stat for channel directory', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1')
    const out = await runStat(
      [
        new PathSpec({
          virtual: '/mnt/discord/My Server__G1/channels/general__C1',
          directory: '/mnt/discord/My Server__G1/channels/general__C1',
          resolved: false,
          resourcePath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
        }),
      ],
      {},
      { index: idx },
    )
    expect(out.stdout).toContain('name=general__C1')
    expect(out.stdout).toContain('type=directory')
  })

  it('formats with -c %n', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1')
    const out = await runStat(
      [
        new PathSpec({
          virtual: '/mnt/discord/My Server__G1/channels/general__C1',
          directory: '/mnt/discord/My Server__G1/channels/general__C1',
          resolved: false,
          resourcePath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
        }),
      ],
      { c: '%n' },
      { index: idx },
    )
    expect(out.stdout).toBe('/mnt/discord/My Server__G1/channels/general__C1\n')
  })

  it('returns exit 1 with no operand', async () => {
    const out = await runStat([], {})
    expect(out.exitCode).toBe(1)
  })
})
