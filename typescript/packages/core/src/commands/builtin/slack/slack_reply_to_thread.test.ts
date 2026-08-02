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
import { SLACK_REPLY_TO_THREAD } from './slack_reply_to_thread.ts'

const DEC = new TextDecoder()

async function runReply(
  flags: Record<string, string | boolean | number | string[]>,
  responder: Responder = (): SlackResponse => ({ ok: true, ts: '2.0' }),
): Promise<{ out: string; transport: FakeSlackTransport }> {
  const cmd = SLACK_REPLY_TO_THREAD[0]
  if (cmd === undefined) throw new Error('slack-reply-to-thread not registered')
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

describe('slack-reply-to-thread command', () => {
  it('replies via chat.postMessage with thread_ts', async () => {
    const { out, transport } = await runReply({ channel_id: 'C1', ts: '1.0', text: 'reply' })
    expect(transport.calls[0]?.endpoint).toBe('chat.postMessage')
    expect(transport.calls[0]?.body).toEqual({ channel: 'C1', thread_ts: '1.0', text: 'reply' })
    expect(JSON.parse(out)).toMatchObject({ ok: true, ts: '2.0' })
  })

  it('throws when --channel_id missing', async () => {
    await expect(runReply({ ts: '1.0', text: 'r' })).rejects.toThrow(/channel_id/)
  })

  it('throws when --ts missing', async () => {
    await expect(runReply({ channel_id: 'C1', text: 'r' })).rejects.toThrow(/ts/)
  })

  it('throws when --text missing', async () => {
    await expect(runReply({ channel_id: 'C1', ts: '1.0' })).rejects.toThrow(/text/)
  })

  it('is registered as a write command', () => {
    const cmd = SLACK_REPLY_TO_THREAD[0]
    expect(cmd?.write).toBe(true)
  })
})
