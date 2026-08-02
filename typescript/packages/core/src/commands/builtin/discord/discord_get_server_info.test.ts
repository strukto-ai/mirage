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
import { DISCORD_GET_SERVER_INFO } from './discord_get_server_info.ts'

const DEC = new TextDecoder()

async function runGetInfo(
  flags: Record<string, string | boolean | number | string[]>,
  responder: Responder = () => ({ id: 'G1', name: 'My Server' }),
): Promise<{ out: string; transport: FakeDiscordTransport }> {
  const cmd = DISCORD_GET_SERVER_INFO[0]
  if (cmd === undefined) throw new Error('discord-get-server-info not registered')
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

describe('discord-get-server-info command', () => {
  it('GETs /guilds/:id and returns JSON', async () => {
    const { out, transport } = await runGetInfo({ guild_id: 'G1' })
    expect(transport.calls[0]?.method).toBe('GET')
    expect(transport.calls[0]?.endpoint).toBe('/guilds/G1')
    expect(JSON.parse(out)).toMatchObject({ id: 'G1', name: 'My Server' })
  })

  it('throws when --guild_id missing', async () => {
    await expect(runGetInfo({})).rejects.toThrow(/guild_id/)
  })

  it('is registered as a read-only command', () => {
    const cmd = DISCORD_GET_SERVER_INFO[0]
    expect(cmd?.write).not.toBe(true)
  })
})
