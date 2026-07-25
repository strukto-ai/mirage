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
import { FakeSlackTransport, makeFakeResource, seedChannel } from './_test_util.ts'
import { SLACK_COMMANDS } from './index.ts'

const SLACK_TREE = SLACK_COMMANDS.filter((c) => c.name === 'tree' && c.filetype == null)

const DEC = new TextDecoder()

async function runTree(
  paths: PathSpec[],
  flags: Record<string, string | boolean | string[]>,
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
          virtual: '/mnt/slack',
          directory: '/mnt/slack',
          resolved: false,
          resourcePath: mountKey('/mnt/slack', '/mnt/slack'),
        }),
      ],
      { L: '1' },
      { index: idx },
    )
    const lines = out.trimEnd().split('\n')
    expect(lines[0]).toBe('/mnt/slack')
    expect(out).toContain('channels')
    expect(out).toContain('dms')
    expect(out).toContain('users')
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
          virtual: '/mnt/slack/channels',
          directory: '/mnt/slack/channels',
          resolved: false,
          resourcePath: mountKey('/mnt/slack/channels', '/mnt/slack'),
        }),
      ],
      {},
      { index: idx, transport },
    )
    expect(out).toContain('general__C1')
    expect(out).toContain('2024-01-01')
  })
})
