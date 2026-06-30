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
import { FakeSlackTransport, makeFakeResource, seedChannel } from './_test_util.ts'
import { SLACK_COMMANDS } from './index.ts'

const SLACK_CAT = SLACK_COMMANDS.filter((c) => c.name === 'cat' && c.filetype == null)

const DEC = new TextDecoder()

async function runCat(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
  options: { index?: RAMIndexCacheStore; transport?: FakeSlackTransport } = {},
): Promise<string> {
  const cmd = SLACK_CAT[0]
  if (cmd === undefined) throw new Error('cat not registered')
  const transport = options.transport ?? new FakeSlackTransport()
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

describe('slack cat', () => {
  it('reads jsonl content from a channel', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { dates: ['2024-01-01'] })
    const transport = new FakeSlackTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return {
          ok: true,
          messages: [
            { ts: '100.0', text: 'hello' },
            { ts: '200.0', text: 'world' },
          ],
        }
      }
      return { ok: true }
    })
    const out = await runCat(
      [
        new PathSpec({
          original: '/mnt/slack/channels/general__C1/2024-01-01/chat.jsonl',
          directory: '/mnt/slack/channels/general__C1/',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      {},
      { index: idx, transport },
    )
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ts: '100.0', text: 'hello' })
  })

  it('returns numbered output with -n', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { dates: ['2024-01-01'] })
    const transport = new FakeSlackTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return { ok: true, messages: [{ ts: '100.0', text: 'hi' }] }
      }
      return { ok: true }
    })
    const out = await runCat(
      [
        new PathSpec({
          original: '/mnt/slack/channels/general__C1/2024-01-01/chat.jsonl',
          directory: '/mnt/slack/channels/general__C1/',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      { n: true },
      { index: idx, transport },
    )
    expect(out.startsWith('     1\t')).toBe(true)
  })

  it('concatenates multiple jsonl files in order (regression: previously only read the first)', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', {
      dates: ['2024-01-01', '2024-01-02', '2024-01-03'],
    })
    // FakeSlackTransport returns deterministic messages per call. We map each
    // day's `oldest` (00:00 UTC) to a distinct message so we can assert order.
    const day1Oldest = String(Math.floor(Date.UTC(2024, 0, 1) / 1000))
    const day2Oldest = String(Math.floor(Date.UTC(2024, 0, 2) / 1000))
    const day3Oldest = String(Math.floor(Date.UTC(2024, 0, 3) / 1000))
    const transport = new FakeSlackTransport((endpoint, params) => {
      if (endpoint === 'conversations.history') {
        const oldest = params?.oldest
        if (oldest === day1Oldest) return { ok: true, messages: [{ ts: '1.0', text: 'day1' }] }
        if (oldest === day2Oldest) return { ok: true, messages: [{ ts: '2.0', text: 'day2' }] }
        if (oldest === day3Oldest) return { ok: true, messages: [{ ts: '3.0', text: 'day3' }] }
        return { ok: true, messages: [] }
      }
      return { ok: true }
    })
    const mkPath = (date: string): PathSpec =>
      new PathSpec({
        original: `/mnt/slack/channels/general__C1/${date}/chat.jsonl`,
        directory: `/mnt/slack/channels/general__C1/`,
        resolved: false,
        prefix: '/mnt/slack',
      })
    const out = await runCat(
      [mkPath('2024-01-01'), mkPath('2024-01-02'), mkPath('2024-01-03')],
      {},
      { index: idx, transport },
    )
    const lines = out.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ts: '1.0', text: 'day1' })
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ ts: '2.0', text: 'day2' })
    expect(JSON.parse(lines[2] ?? '')).toMatchObject({ ts: '3.0', text: 'day3' })
  })
})
