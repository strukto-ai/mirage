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
import type { SlackResponse } from '../../../core/slack/_client.ts'
import { materialize } from '../../../io/types.ts'
import { FakeSlackTransport, makeFakeResource, type Responder } from './_test_util.ts'
import { SLACK_ADD_REACTION } from './slack_add_reaction.ts'

const DEC = new TextDecoder()

async function runReact(
  flags: Record<string, string | boolean | number | string[]>,
  responder: Responder = (): SlackResponse => ({ ok: true }),
): Promise<{ out: string; transport: FakeSlackTransport }> {
  const cmd = SLACK_ADD_REACTION[0]
  if (cmd === undefined) throw new Error('slack-add-reaction not registered')
  const transport = new FakeSlackTransport(responder)
  const resource = makeFakeResource(transport)
  const result = await cmd.fn(resource.accessor, [], [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource,
  })
  if (result === null) return { out: '', transport }
  const [bs] = result
  if (bs === null) return { out: '', transport }
  const buf = bs instanceof Uint8Array ? bs : await materialize(bs as AsyncIterable<Uint8Array>)
  return { out: DEC.decode(buf), transport }
}

describe('slack-add-reaction command', () => {
  it('calls reactions.add with channel/timestamp/name', async () => {
    const { out, transport } = await runReact({
      channel_id: 'C1',
      ts: '1.0',
      reaction: 'thumbsup',
    })
    expect(transport.calls[0]?.endpoint).toBe('reactions.add')
    expect(transport.calls[0]?.body).toEqual({
      channel: 'C1',
      timestamp: '1.0',
      name: 'thumbsup',
    })
    expect(JSON.parse(out)).toMatchObject({ ok: true })
  })

  it('throws when --channel_id missing', async () => {
    await expect(runReact({ ts: '1.0', reaction: 'x' })).rejects.toThrow(/channel_id/)
  })

  it('throws when --ts missing', async () => {
    await expect(runReact({ channel_id: 'C1', reaction: 'x' })).rejects.toThrow(/ts/)
  })

  it('throws when --reaction missing', async () => {
    await expect(runReact({ channel_id: 'C1', ts: '1.0' })).rejects.toThrow(/reaction/)
  })
})
