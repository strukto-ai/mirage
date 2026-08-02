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
import { SLACK_GET_USERS } from './slack_get_users.ts'

const DEC = new TextDecoder()

async function runGetUsers(
  flags: Record<string, string | boolean | number | string[]>,
  responder: Responder,
): Promise<{ out: string; transport: FakeSlackTransport }> {
  const cmd = SLACK_GET_USERS[0]
  if (cmd === undefined) throw new Error('slack-get-users not registered')
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

describe('slack-get-users command', () => {
  it('searches users and returns JSON of matches', async () => {
    const responder: Responder = (): SlackResponse => ({
      ok: true,
      members: [
        { id: 'U1', name: 'alice' },
        { id: 'U2', name: 'bob' },
      ],
    })
    const { out, transport } = await runGetUsers({ query: 'alice' }, responder)
    expect(transport.calls[0]?.endpoint).toBe('users.list')
    const parsed = JSON.parse(out) as { id: string }[]
    expect(parsed.map((u) => u.id)).toEqual(['U1'])
  })

  it('throws when --query missing', async () => {
    await expect(runGetUsers({}, () => ({ ok: true, members: [] }))).rejects.toThrow(/query/)
  })
})
