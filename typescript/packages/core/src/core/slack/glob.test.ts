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
import { SlackAccessor } from '../../accessor/slack.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import { PathSpec } from '../../types.ts'
import type { SlackResponse, SlackTransport } from './_client.ts'
import { SCOPE_ERROR } from '../s3/constants.ts'
import { resolveSlackGlob } from './glob.ts'

class FakeSlackTransport implements SlackTransport {
  public readonly calls: string[] = []
  constructor(
    private readonly responder: (
      endpoint: string,
      params?: Record<string, string>,
    ) => SlackResponse = () => ({ ok: true }),
  ) {}
  call(endpoint: string, params?: Record<string, string>): Promise<SlackResponse> {
    this.calls.push(endpoint)
    return Promise.resolve(this.responder(endpoint, params))
  }
}

async function seedChannelDir(
  idx: RAMIndexCacheStore,
  prefix: string,
  channelDirname: string,
  channelId: string,
  filenames: readonly string[],
): Promise<void> {
  await idx.setDir(`${prefix}/channels`, [
    [
      channelDirname,
      new IndexEntry({
        id: channelId,
        name: channelDirname,
        resourceType: 'slack/channel',
        vfsName: channelDirname,
        remoteTime: '0',
      }),
    ],
  ])
  const dir = `${prefix}/channels/${channelDirname}`
  const entries: [string, IndexEntry][] = filenames.map((name) => [
    name,
    new IndexEntry({
      id: `${channelId}:${name}`,
      name,
      resourceType: 'slack/history',
      vfsName: name,
    }),
  ])
  await idx.setDir(dir, entries)
}

describe('resolveSlackGlob', () => {
  it('passes through resolved PathSpec unchanged', async () => {
    const t = new FakeSlackTransport()
    const idx = new RAMIndexCacheStore()
    const resolved = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1/2026-04-24.jsonl',
      directory: '/mnt/slack/channels/general__C1/',
      resourcePath: mountKey('/mnt/slack/channels/general__C1/2026-04-24.jsonl', '/mnt/slack'),
      resolved: true,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [resolved], idx)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(resolved)
    expect(t.calls).toHaveLength(0)
  })

  it('passes through unresolved PathSpec with no pattern unchanged', async () => {
    const t = new FakeSlackTransport()
    const idx = new RAMIndexCacheStore()
    const noPattern = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1',
      directory: '/mnt/slack/channels/general__C1',
      resourcePath: mountKey('/mnt/slack/channels/general__C1', '/mnt/slack'),
      resolved: false,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [noPattern], idx)
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(noPattern)
    expect(t.calls).toHaveLength(0)
  })

  it('expands a pattern to matching entries via readdir', async () => {
    const t = new FakeSlackTransport()
    const idx = new RAMIndexCacheStore()
    await seedChannelDir(idx, '/mnt/slack', 'general__C1', 'C1', [
      '2026-04-24.jsonl',
      '2026-04-23.jsonl',
      'README.md',
    ])
    const spec = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1/*.jsonl',
      directory: '/mnt/slack/channels/general__C1',
      pattern: '*.jsonl',
      resourcePath: mountKey('/mnt/slack/channels/general__C1/*.jsonl', '/mnt/slack'),
      resolved: false,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [spec], idx)
    expect(out).toHaveLength(2)
    const originals = out.map((p) => p.virtual).sort()
    expect(originals).toEqual([
      '/mnt/slack/channels/general__C1/2026-04-23.jsonl',
      '/mnt/slack/channels/general__C1/2026-04-24.jsonl',
    ])
    for (const p of out) {
      expect(mountPrefixOf(p.virtual, p.resourcePath)).toBe('/mnt/slack')
    }
  })

  it('keeps unmatched pattern word as literal', async () => {
    const t = new FakeSlackTransport()
    const idx = new RAMIndexCacheStore()
    await seedChannelDir(idx, '/mnt/slack', 'general__C1', 'C1', ['2026-04-24.jsonl', 'README.md'])
    const spec = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1/*.csv',
      directory: '/mnt/slack/channels/general__C1',
      pattern: '*.csv',
      resourcePath: mountKey('/mnt/slack/channels/general__C1/*.csv', '/mnt/slack'),
      resolved: false,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [spec], idx)
    // bash nullglob off: the unmatched glob word stays the literal
    expect(out.map((p) => p.virtual)).toEqual([spec.virtual])
    expect(out[0]?.resolved).toBe(true)
    expect(out[0]?.pattern).toBeNull()
  })

  it('truncates matched entries at SCOPE_ERROR', async () => {
    const t = new FakeSlackTransport()
    const idx = new RAMIndexCacheStore()
    const filenames: string[] = []
    for (let i = 0; i < SCOPE_ERROR + 5; i++) {
      filenames.push(`file-${String(i).padStart(5, '0')}.jsonl`)
    }
    await seedChannelDir(idx, '/mnt/slack', 'general__C1', 'C1', filenames)
    const spec = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1/*.jsonl',
      directory: '/mnt/slack/channels/general__C1',
      pattern: '*.jsonl',
      resourcePath: mountKey('/mnt/slack/channels/general__C1/*.jsonl', '/mnt/slack'),
      resolved: false,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [spec], idx)
    expect(out).toHaveLength(SCOPE_ERROR)
  })

  it('handles a mix of resolved, pattern, and no-pattern PathSpecs', async () => {
    const t = new FakeSlackTransport()
    const idx = new RAMIndexCacheStore()
    await seedChannelDir(idx, '/mnt/slack', 'general__C1', 'C1', [
      '2026-04-24.jsonl',
      '2026-04-23.jsonl',
    ])
    const resolved = new PathSpec({
      virtual: '/mnt/slack/users/alice__U1.json',
      directory: '/mnt/slack/users/',
      resourcePath: mountKey('/mnt/slack/users/alice__U1.json', '/mnt/slack'),
      resolved: true,
    })
    const patterned = new PathSpec({
      virtual: '/mnt/slack/channels/general__C1/*.jsonl',
      directory: '/mnt/slack/channels/general__C1',
      pattern: '*.jsonl',
      resourcePath: mountKey('/mnt/slack/channels/general__C1/*.jsonl', '/mnt/slack'),
      resolved: false,
    })
    const noPattern = new PathSpec({
      virtual: '/mnt/slack/channels/eng__C2',
      directory: '/mnt/slack/channels/eng__C2',
      resourcePath: mountKey('/mnt/slack/channels/eng__C2', '/mnt/slack'),
      resolved: false,
    })
    const out = await resolveSlackGlob(new SlackAccessor(t), [resolved, patterned, noPattern], idx)
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(resolved)
    const middle = [out[1]?.virtual, out[2]?.virtual].sort()
    expect(middle).toEqual([
      '/mnt/slack/channels/general__C1/2026-04-23.jsonl',
      '/mnt/slack/channels/general__C1/2026-04-24.jsonl',
    ])
    expect(out[3]).toBe(noPattern)
  })
})
