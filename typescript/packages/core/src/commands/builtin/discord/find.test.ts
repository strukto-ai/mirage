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

import { stripSlash } from '../../../utils/slash.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { RAMIndexCacheStore } from '../../../cache/index/ram.ts'
import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { FakeDiscordTransport, makeFakeResource, seedChannel, seedGuild } from './_test_util.ts'
import { DISCORD_FIND } from './find.ts'

const DEC = new TextDecoder()

async function runFind(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  options: { index?: RAMIndexCacheStore; transport?: FakeDiscordTransport } = {},
): Promise<string> {
  const cmd = DISCORD_FIND[0]
  if (cmd === undefined) throw new Error('find not registered')
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

describe('discord find', () => {
  it('returns chat.jsonl files under a 5-level VFS channel directory', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2024-01-01', '2024-01-02'],
    })
    const transport = new FakeDiscordTransport(() => {
      throw new Error('should not be called')
    })
    const out = await runFind(
      [
        new PathSpec({
          virtual: '/mnt/discord/My Server__G1/channels/general__C1',
          directory: '/mnt/discord/My Server__G1/channels/general__C1',
          resolved: false,
          resourcePath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
        }),
      ],
      { name: 'chat.jsonl' },
      { index: idx, transport },
    )
    const lines = out.split('\n').filter((s) => s !== '')
    expect(lines).toContain('/mnt/discord/My Server__G1/channels/general__C1/2024-01-01/chat.jsonl')
    expect(lines).toContain('/mnt/discord/My Server__G1/channels/general__C1/2024-01-02/chat.jsonl')
  })

  it('exits 1 with a clean error for an invalid -maxdepth', async () => {
    const cmd = DISCORD_FIND[0]
    if (cmd === undefined) throw new Error('find not registered')
    const resource = makeFakeResource(new FakeDiscordTransport())
    const result = await cmd.fn(
      resource.accessor,
      [
        new PathSpec({
          resourcePath: stripSlash('/mnt/discord'),
          virtual: '/mnt/discord',
          directory: '/mnt/discord',
          resolved: false,
        }),
      ],
      [],
      { stdin: null, flags: { maxdepth: 'abc' }, filetypeFns: null, cwd: '/', resource },
    )
    expect(result).not.toBeNull()
    const [out, io] = result as [unknown, { exitCode: number; stderr: AsyncIterable<Uint8Array> }]
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    const buf = io.stderr instanceof Uint8Array ? io.stderr : await materialize(io.stderr)
    expect(DEC.decode(buf)).toBe("find: invalid argument 'abc' to '-maxdepth'\n")
  })
})
