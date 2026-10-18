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
import { SlackAccessor, slackAccessor } from '../../../../accessor/slack.ts'
import type { SlackResponse, SlackTransport } from '../../../../core/slack/client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import { SLACK } from './index.ts'
import { emojiList } from './emoji_list.ts'
import { listPins } from './list_pins.ts'
import { readMessages } from './read_messages.ts'
import { search } from './search.ts'
import { sendMessage } from './send_message.ts'
import { context } from '../../../../../tests/workspace/fixtures/context.ts'

function leafContext(leaf: string, flags: Record<string, string> = {}): Context {
  const spec = SLACK.spec.subcommands.find((s) => s.name === leaf)
  if (spec === undefined) throw new Error(`no slack leaf ${leaf}`)
  return context({ flags, spec })
}

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

const ACCESSOR = new SlackAccessor(new FakeTransport())

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
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
    expect(SLACK.spec.subcommands.map((v) => v.name)).toEqual(VERBS)
    expect(cliSpecFor('slack')).toBe(SLACK)
    expect(SLACK.accessor).toBe(slackAccessor)
  })

  it('classifies writers', () => {
    const writers = new Set(
      SLACK.spec.subcommands.filter((v) => SLACK.handlers[v.name]?.write).map((v) => v.name),
    )
    expect(writers).toEqual(new Set(['send-message', 'react', 'pin-message', 'unpin-message']))
  })
})

describe('slack verbs', () => {
  it('send-message posts, and threads when --thread-ts is given', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, ts: '9.9' }
    await sendMessage(ACCESSOR, [], [], leafContext('send-message', { channel: 'C1', text: 'hi' }))
    await sendMessage(
      ACCESSOR,
      [],
      [],
      leafContext('send-message', { channel: 'C1', text: 'hi', thread_ts: '1.0' }),
    )
    expect(CALLS[0]?.body).toEqual({ channel: 'C1', text: 'hi' })
    expect(CALLS[1]?.body).toEqual({ channel: 'C1', thread_ts: '1.0', text: 'hi' })
  })

  it('read-messages defaults the limit to 20', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, messages: [{ ts: '1.0', text: 'hey' }] }
    const [out] = unwrap(
      await readMessages(ACCESSOR, [], [], leafContext('read-messages', { channel: 'C1' })),
    )
    expect(CALLS[0]?.endpoint).toBe('conversations.history')
    expect(CALLS[0]?.params).toEqual({ channel: 'C1', limit: '20' })
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual([{ ts: '1.0', text: 'hey' }])
  })

  it('read-messages and search keep an explicit zero', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, messages: [] }
    await readMessages(ACCESSOR, [], [], context({ flags: { channel: 'C1', limit: 0 } }))
    await search(ACCESSOR, [], [], context({ flags: { query: 'q', count: 0, page: 0 } }))
    expect(CALLS[0]?.params).toEqual({ channel: 'C1', limit: '0' })
    expect(CALLS[1]?.params).toMatchObject({ query: 'q', count: '0', page: '0' })
  })

  it('list-pins renders the items array', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, items: [{ type: 'message' }] }
    const [out] = unwrap(
      await listPins(ACCESSOR, [], [], leafContext('list-pins', { channel: 'C1' })),
    )
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual([{ type: 'message' }])
  })

  it('emoji-list renders the emoji mapping', async () => {
    CALLS.length = 0
    RESPONSE = { ok: true, emoji: { shipit: 'url' } }
    const [out] = unwrap(await emojiList(ACCESSOR, [], [], leafContext('emoji-list')))
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ shipit: 'url' })
  })
})
