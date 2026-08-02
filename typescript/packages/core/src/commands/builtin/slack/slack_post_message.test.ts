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
import { SLACK_POST_MESSAGE } from './slack_post_message.ts'

const DEC = new TextDecoder()

async function runPost(
  flags: Record<string, string | boolean | number | string[]>,
  responder: Responder = (): SlackResponse => ({ ok: true, ts: '1.0' }),
): Promise<{ out: string; transport: FakeSlackTransport }> {
  const cmd = SLACK_POST_MESSAGE[0]
  if (cmd === undefined) throw new Error('slack-post-message not registered')
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

describe('slack-post-message command', () => {
  it('posts to chat.postMessage with channel + text and returns JSON', async () => {
    const { out, transport } = await runPost({ channel_id: 'C1', text: 'hi' })
    expect(transport.calls[0]?.endpoint).toBe('chat.postMessage')
    expect(transport.calls[0]?.body).toEqual({ channel: 'C1', text: 'hi' })
    expect(JSON.parse(out)).toMatchObject({ ok: true, ts: '1.0' })
  })

  it('throws when --channel_id missing', async () => {
    await expect(runPost({ text: 'hi' })).rejects.toThrow(/channel_id/)
  })

  it('throws when --text missing', async () => {
    await expect(runPost({ channel_id: 'C1' })).rejects.toThrow(/text/)
  })

  it('is registered as a write command', () => {
    const cmd = SLACK_POST_MESSAGE[0]
    expect(cmd?.write).toBe(true)
  })
})
