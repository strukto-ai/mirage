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
import { FakeDiscordTransport, makeFakeVfs, seedChannel, seedGuild } from './_test_util.ts'
import { DISCORD_GREP } from './grep.ts'

const DEC = new TextDecoder()

async function runGrep(
  paths: PathSpec[],
  texts: string[],
  flags: Record<string, string | boolean | number | string[]>,
  options: { index?: RAMIndexCacheStore; transport?: FakeDiscordTransport } = {},
): Promise<{ stdout: string; exitCode: number }> {
  const cmd = DISCORD_GREP[0]
  if (cmd === undefined) throw new Error('grep not registered')
  const transport = options.transport ?? new FakeDiscordTransport()
  const vfs = makeFakeVfs(transport)
  const result = await cmd.fn(vfs.accessor, paths, texts, {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
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

describe('discord grep', () => {
  it('uses native search for a channel directory path', async () => {
    const transport = new FakeDiscordTransport((_method, endpoint) => {
      if (endpoint === '/guilds/G1/messages/search') {
        return {
          total_results: 1,
          messages: [
            [
              {
                id: '175928847299117056',
                content: 'hello world',
                channel_id: 'C1',
                timestamp: '2016-04-30T12:00:00.000+00:00',
                author: { username: 'alice' },
              },
            ],
          ],
        }
      }
      return null
    })
    const out = await runGrep(
      [
        new PathSpec({
          virtual: '/mnt/discord/My Server__G1/channels/general__C1',
          directory: '/mnt/discord/My Server__G1/channels/general__C1',
          resolved: false,
          vfsPath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
        }),
      ],
      ['hello'],
      { w: true },
      { transport },
    )
    expect(transport.calls[0]?.endpoint).toBe('/guilds/G1/messages/search')
    expect(transport.calls[0]?.params?.content).toBe('hello')
    expect(transport.calls[0]?.params?.channel_id).toBe('C1')
    const lines = out.stdout.split('\n').filter((l) => l !== '')
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('hello world')
    expect(lines[0]).toContain('alice')
  })

  it('matches lines containing pattern in jsonl file', async () => {
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2016-04-30'],
    })
    const transport = new FakeDiscordTransport((_method, endpoint) => {
      if (endpoint === '/channels/C1/messages') {
        return [
          { id: '175928847299117056', content: 'hello world' },
          { id: '175928847299117057', content: 'goodbye' },
          { id: '175928847299117058', content: 'hello again' },
        ]
      }
      return null
    })
    const out = await runGrep(
      [
        new PathSpec({
          virtual: '/mnt/discord/My Server__G1/channels/general__C1/2016-04-30/chat.jsonl',
          directory: '/mnt/discord/My Server__G1/channels/general__C1/',
          resolved: false,
          vfsPath: mountKey(
            '/mnt/discord/My Server__G1/channels/general__C1/2016-04-30/chat.jsonl',
            '/mnt/discord',
          ),
        }),
      ],
      ['hello'],
      {},
      { index: idx, transport },
    )
    const lines = out.stdout.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(2)
    for (const l of lines) {
      expect(l).toContain('hello')
    }
  })

  it('two chat.jsonl operands take the scan rather than one widened search', async () => {
    // They used to coalesce into one channel-wide search, which answered for
    // every day the channel ever had — `searchGuild` takes a channel but no
    // date. The scan reads exactly the two days the line named.
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2016-04-29', '2016-04-30'],
    })
    const transport = new FakeDiscordTransport((_method, endpoint) =>
      endpoint === '/channels/C1/messages' ? [] : null,
    )
    const mk = (date: string): PathSpec =>
      new PathSpec({
        virtual: `/mnt/discord/My Server__G1/channels/general__C1/${date}/chat.jsonl`,
        directory: `/mnt/discord/My Server__G1/channels/general__C1/${date}/chat.jsonl`,
        resolved: true,
        vfsPath: mountKey(
          `/mnt/discord/My Server__G1/channels/general__C1/${date}/chat.jsonl`,
          '/mnt/discord',
        ),
      })
    await runGrep(
      [mk('2016-04-29'), mk('2016-04-30')],
      ['hello'],
      { w: true },
      {
        index: idx,
        transport,
      },
    )
    const searches = transport.calls.filter((c) => c.endpoint.includes('/messages/search'))
    expect(searches).toHaveLength(0)
  })

  it('a second operand defers the whole line to the scan', async () => {
    // The push-down answers for one channel, so the second operand used to be
    // dropped in silence: this line reported general and never mentioned
    // random at all.
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2016-04-30'],
    })
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'random__C2', 'C2', {
      dates: ['2016-04-30'],
    })
    const transport = new FakeDiscordTransport((_method, endpoint) =>
      endpoint.endsWith('/messages') ? [] : null,
    )
    const dir = (name: string): PathSpec =>
      new PathSpec({
        virtual: `/mnt/discord/My Server__G1/channels/${name}`,
        directory: `/mnt/discord/My Server__G1/channels/${name}`,
        resolved: false,
        vfsPath: mountKey(`/mnt/discord/My Server__G1/channels/${name}`, '/mnt/discord'),
      })
    await runGrep(
      [dir('general__C1'), dir('random__C2')],
      ['hello'],
      { w: true, r: true },
      {
        index: idx,
        transport,
      },
    )
    const searches = transport.calls.filter((c) => c.endpoint.includes('/messages/search'))
    expect(searches).toHaveLength(0)
  })

  it('scans attachment blobs instead of widening to a message search', async () => {
    // The blob does not exist, so the scan fails per-operand — the pin is
    // that the search endpoint is never consulted for a file_blob path.
    const idx = new RAMIndexCacheStore()
    await seedGuild(idx, '/mnt/discord', 'My Server__G1', 'G1')
    await seedChannel(idx, '/mnt/discord', 'My Server__G1', 'general__C1', 'C1', {
      dates: ['2016-04-30'],
    })
    const transport = new FakeDiscordTransport((_method, endpoint) =>
      endpoint === '/channels/C1/messages' ? [] : null,
    )
    const blob = '/mnt/discord/My Server__G1/channels/general__C1/2016-04-30/files/data__A1.csv'
    const out = await runGrep(
      [
        new PathSpec({
          virtual: blob,
          directory: blob,
          resolved: false,
          vfsPath: mountKey(blob, '/mnt/discord'),
        }),
      ],
      ['quarter'],
      { w: true },
      { index: idx, transport },
    )
    const searches = transport.calls.filter((c) => c.endpoint.includes('/messages/search'))
    expect(searches).toHaveLength(0)
    expect(out.exitCode).not.toBe(0)
  })
})
