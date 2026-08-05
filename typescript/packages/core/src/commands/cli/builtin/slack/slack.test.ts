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

import { describe, expect, it, vi } from 'vitest'
import { SlackAccessor } from '../../../../accessor/slack.ts'
import type { SlackResponse, SlackTransport } from '../../../../core/slack/_client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { SLACK } from './index.ts'
import { emojiList } from './emoji_list.ts'
import { listPins } from './list_pins.ts'
import { readMessages } from './read_messages.ts'
import { sendMessage } from './send_message.ts'

const DEC = new TextDecoder()

interface Recorded {
  endpoint: string
  params?: Record<string, string>
  body?: unknown
}

const CALLS: Recorded[] = []
let RESPONSE: SlackResponse = { ok: true }

class FakeTransport implements SlackTransport {
  call(endpoint: string, params?: Record<string, string>, body?: unknown): Promise<SlackResponse> {
    CALLS.push({
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(RESPONSE)
  }
}

vi.mock('./accessor.ts', () => ({
  slackAccessor: () => new SlackAccessor(new FakeTransport()),
}))

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
}

function makeInv(config: unknown, flags: CLIInvocation['flags']): CLIInvocation {
  return { config, argv: [], paths: [], texts: [], flags, stdin: null, env: {} }
}

const VERBS = [
  'send-message',
  'read-messages',
  'react',
  'reactions',
  'pin-message',
  'unpin-message',
  'list-pins',
  'member-info',
  'list-members',
  'emoji-list',
  'search',
]

describe('slack tree', () => {
  it('matches the OpenClaw vocabulary and registers itself', () => {
    expect(SLACK.subcommands.map((v) => v.name)).toEqual(VERBS)
    expect(cliSpecFor('slack')).toBe(SLACK)
  })

  it('classifies writers', () => {
    const writers = new Set(SLACK.subcommands.filter((v) => v.write).map((v) => v.name))
    expect(writers).toEqual(new Set(['send-message', 'react', 'pin-message', 'unpin-message']))
  })
})

describe('slack verbs', () => {
  it('send-message posts, and threads when --thread-ts is given', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, ts: '9.9' }
    await sendMessage(makeInv({}, { channel: 'C1', text: 'hi' }))
    await sendMessage(makeInv({}, { channel: 'C1', text: 'hi', thread_ts: '1.0' }))
    expect(CALLS[0]?.body).toEqual({ channel: 'C1', text: 'hi' })
    expect(CALLS[1]?.body).toEqual({ channel: 'C1', thread_ts: '1.0', text: 'hi' })
  })

  it('read-messages defaults the limit to 20', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, messages: [{ ts: '1.0', text: 'hey' }] }
    const [out] = unwrap(await readMessages(makeInv({}, { channel: 'C1' })))
    expect(CALLS[0]?.endpoint).toBe('conversations.history')
    expect(CALLS[0]?.params).toEqual({ channel: 'C1', limit: '20' })
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual([{ ts: '1.0', text: 'hey' }])
  })

  it('list-pins renders the items array', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, items: [{ type: 'message' }] }
    const [out] = unwrap(await listPins(makeInv({}, { channel: 'C1' })))
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual([{ type: 'message' }])
  })

  it('emoji-list renders the emoji mapping', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, emoji: { shipit: 'url' } }
    const [out] = unwrap(await emojiList(makeInv({}, {})))
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ shipit: 'url' })
  })
})
