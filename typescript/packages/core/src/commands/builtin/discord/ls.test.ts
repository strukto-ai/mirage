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

const DISCORD_LS = DISCORD_COMMANDS.filter((c) => c.name === 'ls' && c.filetype == null)

const DEC = new TextDecoder()

async function runLs(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  options: {
    index?: RAMIndexCacheStore
    transport?: FakeDiscordTransport
    cwd?: string
    mountPrefix?: string
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cmd = DISCORD_LS[0]
  if (cmd === undefined) throw new Error('ls not registered')
  const transport = options.transport ?? new FakeDiscordTransport()
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, paths, [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: options.cwd ?? '/',
    resource,
    ...(options.mountPrefix !== undefined ? { mountPrefix: options.mountPrefix } : {}),
    ...(options.index !== undefined ? { index: options.index } : {}),
  })
  if (result === null) return { stdout: '', stderr: '', exitCode: 0 }
  const [out, io] = result
  const stdoutBytes =
    out === null
      ? new Uint8Array()
      : out instanceof Uint8Array
        ? out
        : await materialize(out as AsyncIterable<Uint8Array>)
  const stderrBytes = await io.materializeStderr()
  return {
    stdout: DEC.decode(stdoutBytes),
    stderr: DEC.decode(stderrBytes),
    exitCode: io.exitCode,
  }
}

describe('discord ls', () => {
  it('lists guild dir entries (channels/members)', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    const out = await runLs(
      [
        new PathSpec({
          original: '/mnt/discord/My Server__G1',
          directory: '/mnt/discord/My Server__G1',
          resolved: false,
          prefix: '/mnt/discord',
        }),
      ],
      {},
      { index: idx },
    )
    expect(out.stdout.trimEnd().split('\n').sort()).toEqual(['channels', 'members'])
  })

  it('lists channels under a guild from cached index', async () => {
    const idx = new RAMIndexCacheStore()
    const transport = new FakeDiscordTransport(() => {
      throw new Error('should not be called')
    })
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1')
    const out = await runLs(
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
    expect(out.stdout).toBe('general__C1\n')
    expect(transport.calls).toHaveLength(0)
  })

  it('walks 4-level VFS and lists date directories', async () => {
    const idx = new RAMIndexCacheStore()
    const transport = new FakeDiscordTransport(() => {
      throw new Error('should not be called')
    })
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2024-01-01', '2024-01-02'],
    })
    const out = await runLs(
      [
        new PathSpec({
          original: '/mnt/discord/My Server__G1/channels/general__C1',
          directory: '/mnt/discord/My Server__G1/channels/general__C1',
          resolved: false,
          prefix: '/mnt/discord',
        }),
      ],
      {},
      { index: idx, transport },
    )
    const lines = out.stdout.trimEnd().split('\n').sort()
    expect(lines).toEqual(['2024-01-01', '2024-01-02'])
  })
})
