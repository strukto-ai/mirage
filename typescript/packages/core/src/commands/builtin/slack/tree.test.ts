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
import { SLACK_TREE } from './tree.ts'

const DEC = new TextDecoder()

async function runTree(
  paths: PathSpec[],
  flags: Record<string, string | boolean>,
  options: { index?: RAMIndexCacheStore; transport?: FakeSlackTransport } = {},
): Promise<string> {
  const cmd = SLACK_TREE[0]
  if (cmd === undefined) throw new Error('tree not registered')
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

describe('slack tree', () => {
  it('renders depth-1 listing of root', async () => {
    const idx = new RAMIndexCacheStore()
    const out = await runTree(
      [
        new PathSpec({
          original: '/mnt/slack',
          directory: '/mnt/slack',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      { L: '1' },
      { index: idx },
    )
    const lines = out.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('channels')
    expect(lines[1]).toContain('dms')
    expect(lines[2]).toContain('users')
  })

  it('descends into channels subtree from cached index', async () => {
    const idx = new RAMIndexCacheStore()
    const transport = new FakeSlackTransport(() => {
      throw new Error('should not be called')
    })
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { dates: ['2024-01-01'] })
    const out = await runTree(
      [
        new PathSpec({
          original: '/mnt/slack/channels',
          directory: '/mnt/slack/channels',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      {},
      { index: idx, transport },
    )
    expect(out).toContain('general__C1')
    expect(out).toContain('2024-01-01')
  })
})
