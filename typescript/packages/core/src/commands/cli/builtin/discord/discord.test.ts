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
import { DiscordAccessor } from '../../../../accessor/discord.ts'
import type {
  DiscordMethod,
  DiscordResponse,
  DiscordTransport,
} from '../../../../core/discord/_client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import type { CLIInvocation } from '../../types.ts'
import { DISCORD } from './index.ts'
import { deleteVerb } from './delete.ts'
import { poll } from './poll.ts'
import { read } from './read.ts'
import { send } from './send.ts'
import { threadCreate } from './thread_create.ts'

const DEC = new TextDecoder()

interface Recorded {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

const CALLS: Recorded[] = []
let RESPONSE: DiscordResponse = { id: 'M1' }

class FakeTransport implements DiscordTransport {
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    CALLS.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(RESPONSE)
  }
}

vi.mock('./accessor.ts', () => ({
  discordAccessor: () => new DiscordAccessor(new FakeTransport()),
}))

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
}

function makeInv(config: unknown, flags: CLIInvocation['flags']): CLIInvocation {
  return { config, argv: [], paths: [], texts: [], flags, stdin: null, env: {} }
}

const VERBS = [
  'send',
  'read',
  'edit',
  'delete',
  'react',
  'search',
  'thread-create',
  'poll',
  'members',
  'server-info',
]

describe('discord tree', () => {
  it('matches the OpenClaw vocabulary and registers itself', () => {
    expect(DISCORD.subcommands.map((v) => v.name)).toEqual(VERBS)
    expect(cliSpecFor('discord')).toBe(DISCORD)
  })

  it('classifies writers and keeps --answer repeatable', () => {
    const writers = new Set(DISCORD.subcommands.filter((v) => v.write).map((v) => v.name))
    expect(writers).toEqual(new Set(['send', 'edit', 'delete', 'react', 'thread-create', 'poll']))
    const pollSpec = DISCORD.subcommands.find((v) => v.name === 'poll')
    const answer = pollSpec?.options.find((o) => o.long === '--answer')
    expect(answer?.multiple).toBe(true)
    expect(answer?.required).toBe(true)
  })
})

describe('discord verbs', () => {
  it('send forwards --reply-to as a message reference', async () => {
    CALLS.length = 0
    await send(makeInv({}, { channel: 'C1', text: 're', reply_to: 'M0' }))
    expect(CALLS[0]?.body).toEqual({ content: 're', message_reference: { message_id: 'M0' } })
  })

  it('read sorts oldest-first', async () => {
    CALLS.length = 0
    RESPONSE = [{ id: '20' }, { id: '10' }]
    const [out] = unwrap(await read(makeInv({}, { channel: 'C1' })))
    expect(CALLS[0]?.params).toEqual({ limit: 20 })
    expect(
      (JSON.parse(DEC.decode(out as Uint8Array)) as { id: string }[]).map((m) => m.id),
    ).toEqual(['10', '20'])
    RESPONSE = { id: 'M1' }
  })

  it('delete DELETEs and reports ok', async () => {
    CALLS.length = 0
    RESPONSE = null
    const [out] = unwrap(await deleteVerb(makeInv({}, { channel: 'C1', message: 'M1' })))
    expect(CALLS[0]?.method).toBe('DELETE')
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ ok: true })
    RESPONSE = { id: 'M1' }
  })

  it('thread-create starts from a message when given', async () => {
    CALLS.length = 0
    await threadCreate(makeInv({}, { channel: 'C1', name: 'topic', message: 'M1' }))
    expect(CALLS[0]?.endpoint).toBe('/channels/C1/messages/M1/threads')
  })

  it('poll shapes the poll object with defaults', async () => {
    CALLS.length = 0
    await poll(makeInv({}, { channel: 'C1', question: 'Lunch?', answer: ['A', 'B'] }))
    expect(CALLS[0]?.body).toEqual({
      poll: {
        question: { text: 'Lunch?' },
        answers: [{ poll_media: { text: 'A' } }, { poll_media: { text: 'B' } }],
        duration: 24,
        allow_multiselect: false,
      },
    })
  })
})
