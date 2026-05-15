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
import { SLACK_FIND } from './find.ts'

const DEC = new TextDecoder()

async function runFind(
  paths: PathSpec[],
  flags: Record<string, string | boolean>,
  options: { index?: RAMIndexCacheStore; transport?: FakeSlackTransport } = {},
): Promise<string> {
  const cmd = SLACK_FIND[0]
  if (cmd === undefined) throw new Error('find not registered')
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

describe('slack find', () => {
  it('returns *.jsonl files under a channel directory', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', {
      dates: ['2024-01-01', '2024-01-02'],
    })
    const transport = new FakeSlackTransport(() => {
      throw new Error('should not be called')
    })
    const out = await runFind(
      [
        new PathSpec({
          original: '/mnt/slack/channels/general__C1',
          directory: '/mnt/slack/channels/general__C1',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      { name: '*.jsonl' },
      { index: idx, transport },
    )
    const lines = out.split('\n').filter((s) => s !== '')
    expect(lines).toContain('/mnt/slack/channels/general__C1/2024-01-01/chat.jsonl')
    expect(lines).toContain('/mnt/slack/channels/general__C1/2024-01-02/chat.jsonl')
  })
})
