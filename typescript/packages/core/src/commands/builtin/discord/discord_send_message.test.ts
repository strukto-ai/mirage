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
import { FakeDiscordTransport, makeFakeResource, type Responder } from './_test_util.ts'
import { DISCORD_SEND_MESSAGE } from './discord_send_message.ts'

const DEC = new TextDecoder()

async function runSend(
  flags: Record<string, string | boolean | number | string[]>,
  responder: Responder = () => ({ id: 'M1', content: 'hi' }),
): Promise<{ out: string; transport: FakeDiscordTransport }> {
  const cmd = DISCORD_SEND_MESSAGE[0]
  if (cmd === undefined) throw new Error('discord-send-message not registered')
  const transport = new FakeDiscordTransport(responder)
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

describe('discord-send-message command', () => {
  it('posts to /channels/:id/messages with content and returns JSON', async () => {
    const { out, transport } = await runSend({ channel_id: 'C1', text: 'hi' })
    expect(transport.calls[0]?.method).toBe('POST')
    expect(transport.calls[0]?.endpoint).toBe('/channels/C1/messages')
    expect(transport.calls[0]?.body).toEqual({ content: 'hi' })
    expect(JSON.parse(out)).toMatchObject({ id: 'M1', content: 'hi' })
  })

  it('passes message_reference when --message_id provided', async () => {
    const { transport } = await runSend({ channel_id: 'C1', text: 'hi', message_id: 'M0' })
    expect(transport.calls[0]?.body).toEqual({
      content: 'hi',
      message_reference: { message_id: 'M0' },
    })
  })

  it('throws when --channel_id missing', async () => {
    await expect(runSend({ text: 'hi' })).rejects.toThrow(/channel_id/)
  })

  it('throws when --text missing', async () => {
    await expect(runSend({ channel_id: 'C1' })).rejects.toThrow(/text/)
  })

  it('is registered as a write command', () => {
    const cmd = DISCORD_SEND_MESSAGE[0]
    expect(cmd?.write).toBe(true)
  })
})
