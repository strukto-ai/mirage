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
import { materialize } from '../../../io/types.ts'
import { FakeSlackTransport, makeFakeResource } from './_test_util.ts'
import { SLACK_COMMANDS } from './index.ts'

const SLACK_DIRNAME = SLACK_COMMANDS.filter((c) => c.name === 'dirname' && c.filetype == null)

const DEC = new TextDecoder()

async function runDirname(texts: string[]): Promise<string> {
  const cmd = SLACK_DIRNAME[0]
  if (cmd === undefined) throw new Error('dirname not registered')
  const transport = new FakeSlackTransport()
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, [], texts, {
    stdin: null,
    flags: {},
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return ''
  const [out] = result
  if (out === null) return ''
  const buf = out instanceof Uint8Array ? out : await materialize(out as AsyncIterable<Uint8Array>)
  return DEC.decode(buf)
}

describe('slack dirname', () => {
  it('returns parent directory', async () => {
    expect(await runDirname(['/mnt/slack/channels/general__C1/2024-01-01.jsonl'])).toBe(
      '/mnt/slack/channels/general__C1\n',
    )
  })

  it('returns / for top-level path', async () => {
    expect(await runDirname(['/foo'])).toBe('/\n')
  })
})
