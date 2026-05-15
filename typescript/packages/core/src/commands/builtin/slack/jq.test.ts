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
import { SLACK_JQ } from './jq.ts'

const DEC = new TextDecoder()

async function runJq(
  paths: PathSpec[],
  texts: string[],
  flags: Record<string, string | boolean>,
  options: { index?: RAMIndexCacheStore; transport?: FakeSlackTransport } = {},
): Promise<{ stdout: string; exitCode: number }> {
  const cmd = SLACK_JQ[0]
  if (cmd === undefined) throw new Error('jq not registered')
  const transport = options.transport ?? new FakeSlackTransport()
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, paths, texts, {
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

describe('slack jq', () => {
  it('extracts .text from jsonl messages with .[].text', async () => {
    const idx = new RAMIndexCacheStore()
    await seedChannel(idx, '/mnt/slack', 'general__C1', 'C1', { dates: ['2024-01-01'] })
    const transport = new FakeSlackTransport((endpoint) => {
      if (endpoint === 'conversations.history') {
        return {
          ok: true,
          messages: [
            { ts: '1.0', text: 'hello' },
            { ts: '2.0', text: 'world' },
          ],
        }
      }
      return { ok: true }
    })
    const out = await runJq(
      [
        new PathSpec({
          original: '/mnt/slack/channels/general__C1/2024-01-01/chat.jsonl',
          directory: '/mnt/slack/channels/general__C1/',
          resolved: false,
          prefix: '/mnt/slack',
        }),
      ],
      ['.[].text'],
      { r: true },
      { index: idx, transport },
    )
    const lines = out.stdout.split('\n').filter((s) => s !== '')
    expect(lines).toEqual(['hello', 'world'])
  })
})
