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
import { DISCORD_ADD_REACTION } from './discord_add_reaction.ts'

const DEC = new TextDecoder()

async function runReact(
  flags: Record<string, string | boolean | number | string[]>,
  responder: Responder = () => null,
): Promise<{ out: string; transport: FakeDiscordTransport }> {
  const cmd = DISCORD_ADD_REACTION[0]
  if (cmd === undefined) throw new Error('discord-add-reaction not registered')
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

describe('discord-add-reaction command', () => {
  it('PUTs to reactions endpoint and returns {ok: true}', async () => {
    const { out, transport } = await runReact({
      channel_id: 'C1',
      message_id: 'M1',
      reaction: 'thumbsup',
    })
    expect(transport.calls[0]?.method).toBe('PUT')
    expect(transport.calls[0]?.endpoint).toBe('/channels/C1/messages/M1/reactions/thumbsup/@me')
    expect(JSON.parse(out)).toEqual({ ok: true })
  })

  it('url-encodes the emoji', async () => {
    const { transport } = await runReact({
      channel_id: 'C1',
      message_id: 'M1',
      reaction: 'fire:🔥',
    })
    expect(transport.calls[0]?.endpoint).toBe(
      `/channels/C1/messages/M1/reactions/${encodeURIComponent('fire:🔥')}/@me`,
    )
  })

  it('throws when --channel_id missing', async () => {
    await expect(runReact({ message_id: 'M1', reaction: 'x' })).rejects.toThrow(/channel_id/)
  })

  it('throws when --message_id missing', async () => {
    await expect(runReact({ channel_id: 'C1', reaction: 'x' })).rejects.toThrow(/message_id/)
  })

  it('throws when --reaction missing', async () => {
    await expect(runReact({ channel_id: 'C1', message_id: 'M1' })).rejects.toThrow(/reaction/)
  })

  it('is registered as a write command', () => {
    const cmd = DISCORD_ADD_REACTION[0]
    expect(cmd?.write).toBe(true)
  })
})
