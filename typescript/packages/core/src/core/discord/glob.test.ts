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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { DiscordAccessor } from '../../accessor/discord.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { SCOPE_ERROR } from '../s3/constants.ts'
import { resolveDiscordGlob } from './glob.ts'

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

async function seedChannelHistory(
  idx: RAMIndexCacheStore,
  prefix: string,
  guildDir: string,
  channelDir: string,
  filenames: readonly string[],
): Promise<void> {
  const dir = `${prefix}/${guildDir}/channels/${channelDir}`
  const entries: [string, IndexEntry][] = filenames.map((name) => [
    name,
    new IndexEntry({
      id: `${channelDir}:${name}`,
      name,
      resourceType: 'discord/history',
      vfsName: name,
    }),
  ])
  await idx.setDir(dir, entries)
}

describe('resolveDiscordGlob', () => {
  it('passes through resolved PathSpec unchanged', async () => {
    const t = new FakeDiscordTransport()
    const idx = new RAMIndexCacheStore()
    const resolved = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
      directory: '/mnt/discord/My Server__G1/channels/general__C1/',
      resourcePath: mountKey(
        '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
        '/mnt/discord',
      ),
      resolved: true,
    })
    const out = await resolveDiscordGlob(new DiscordAccessor(t), [resolved], idx)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(resolved)
    expect(t.calls).toHaveLength(0)
  })

  it('passes through unresolved PathSpec with no pattern unchanged', async () => {
    const t = new FakeDiscordTransport()
    const idx = new RAMIndexCacheStore()
    const noPattern = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1',
      directory: '/mnt/discord/My Server__G1/channels/general__C1',
      resourcePath: mountKey('/mnt/discord/My Server__G1/channels/general__C1', '/mnt/discord'),
      resolved: false,
    })
    const out = await resolveDiscordGlob(new DiscordAccessor(t), [noPattern], idx)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(noPattern)
    expect(t.calls).toHaveLength(0)
  })

  it('expands a pattern to matching entries via readdir', async () => {
    const t = new FakeDiscordTransport()
    const idx = new RAMIndexCacheStore()
    await seedChannelHistory(idx, '/mnt/discord', 'My Server__G1', 'general__C1', [
      '2026-04-24.jsonl',
      '2026-04-23.jsonl',
      'README.md',
    ])
    const spec = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1/*.jsonl',
      directory: '/mnt/discord/My Server__G1/channels/general__C1',
      pattern: '*.jsonl',
      resourcePath: mountKey(
        '/mnt/discord/My Server__G1/channels/general__C1/*.jsonl',
        '/mnt/discord',
      ),
      resolved: false,
    })
    const out = await resolveDiscordGlob(new DiscordAccessor(t), [spec], idx)
    expect(out).toHaveLength(2)
    const originals = out.map((p) => p.virtual).sort()
    expect(originals).toEqual([
      '/mnt/discord/My Server__G1/channels/general__C1/2026-04-23.jsonl',
      '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
    ])
    for (const p of out) {
      expect(mountPrefixOf(p.virtual, p.resourcePath)).toBe('/mnt/discord')
    }
  })

  it('returns empty when pattern matches nothing', async () => {
    const t = new FakeDiscordTransport()
    const idx = new RAMIndexCacheStore()
    await seedChannelHistory(idx, '/mnt/discord', 'My Server__G1', 'general__C1', [
      '2026-04-24.jsonl',
      'README.md',
    ])
    const spec = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1/*.csv',
      directory: '/mnt/discord/My Server__G1/channels/general__C1',
      pattern: '*.csv',
      resourcePath: mountKey(
        '/mnt/discord/My Server__G1/channels/general__C1/*.csv',
        '/mnt/discord',
      ),
      resolved: false,
    })
    const out = await resolveDiscordGlob(new DiscordAccessor(t), [spec], idx)
    expect(out).toEqual([])
  })

  it('truncates matched entries at SCOPE_ERROR', async () => {
    const t = new FakeDiscordTransport()
    const idx = new RAMIndexCacheStore()
    const filenames: string[] = []
    for (let i = 0; i < SCOPE_ERROR + 5; i++) {
      filenames.push(`file-${String(i).padStart(5, '0')}.jsonl`)
    }
    await seedChannelHistory(idx, '/mnt/discord', 'My Server__G1', 'general__C1', filenames)
    const spec = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1/*.jsonl',
      directory: '/mnt/discord/My Server__G1/channels/general__C1',
      pattern: '*.jsonl',
      resourcePath: mountKey(
        '/mnt/discord/My Server__G1/channels/general__C1/*.jsonl',
        '/mnt/discord',
      ),
      resolved: false,
    })
    const out = await resolveDiscordGlob(new DiscordAccessor(t), [spec], idx)
    expect(out).toHaveLength(SCOPE_ERROR)
  })

  it('handles a mix of resolved, pattern, and no-pattern PathSpecs', async () => {
    const t = new FakeDiscordTransport()
    const idx = new RAMIndexCacheStore()
    await seedChannelHistory(idx, '/mnt/discord', 'My Server__G1', 'general__C1', [
      '2026-04-24.jsonl',
      '2026-04-23.jsonl',
    ])
    const resolved = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/members/alice__U1.json',
      directory: '/mnt/discord/My Server__G1/members/',
      resourcePath: mountKey('/mnt/discord/My Server__G1/members/alice__U1.json', '/mnt/discord'),
      resolved: true,
    })
    const patterned = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/general__C1/*.jsonl',
      directory: '/mnt/discord/My Server__G1/channels/general__C1',
      pattern: '*.jsonl',
      resourcePath: mountKey(
        '/mnt/discord/My Server__G1/channels/general__C1/*.jsonl',
        '/mnt/discord',
      ),
      resolved: false,
    })
    const noPattern = new PathSpec({
      virtual: '/mnt/discord/My Server__G1/channels/eng__C2',
      directory: '/mnt/discord/My Server__G1/channels/eng__C2',
      resourcePath: mountKey('/mnt/discord/My Server__G1/channels/eng__C2', '/mnt/discord'),
      resolved: false,
    })
    const out = await resolveDiscordGlob(
      new DiscordAccessor(t),
      [resolved, patterned, noPattern],
      idx,
    )
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(resolved)
    const middle = [out[1]?.virtual, out[2]?.virtual].sort()
    expect(middle).toEqual([
      '/mnt/discord/My Server__G1/channels/general__C1/2026-04-23.jsonl',
      '/mnt/discord/My Server__G1/channels/general__C1/2026-04-24.jsonl',
    ])
    expect(out[3]).toBe(noPattern)
  })
})
