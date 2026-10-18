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

import { compileSpec } from '../../../spec/compile.ts'
import { describe, expect, it } from 'vitest'
import { DiscordAccessor, discordAccessor } from '../../../../accessor/discord.ts'
import type {
  DiscordMethod,
  DiscordResponse,
  DiscordTransport,
} from '../../../../core/discord/client.ts'
import { cliSpecFor } from '../../specs.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import type { ByteSource, IOResult } from '../../../../io/types.ts'
import { DISCORD } from './index.ts'
import { deleteVerb } from './delete.ts'
import { edit } from './edit.ts'
import { members } from './members.ts'
import { poll } from './poll.ts'
import { react } from './react.ts'
import { read } from './read.ts'
import { search } from './search.ts'
import { send } from './send.ts'
import { serverInfo } from './server_info.ts'
import { threadCreate } from './thread_create.ts'
import { context } from '../../../../workspace/fixtures/context.ts'
import type { FlagValue } from '../../../spec/types.ts'

function leafContext(leaf: string, flags: Record<string, FlagValue> = {}): Context {
  const spec = DISCORD.spec.subcommands.find((s) => s.name === leaf)
  if (spec === undefined) throw new Error(`no discord leaf ${leaf}`)
  return context({ flags, spec })
}

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

const ACCESSOR = new DiscordAccessor(new FakeTransport())

function unwrap(result: CommandFnResult): [ByteSource | null, IOResult] {
  if (result === null) throw new Error('expected a result tuple')
  return result
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
    expect(DISCORD.spec.subcommands.map((v) => v.name)).toEqual(VERBS)
    expect(cliSpecFor('discord')).toBe(DISCORD)
    expect(DISCORD.accessor).toBe(discordAccessor)
  })

  it('classifies writers and keeps --answer repeatable', () => {
    const writers = new Set(
      DISCORD.spec.subcommands.filter((v) => DISCORD.handlers[v.name]?.write).map((v) => v.name),
    )
    expect(writers).toEqual(new Set(['send', 'edit', 'delete', 'react', 'thread-create', 'poll']))
    const pollSpec = DISCORD.spec.subcommands.find((v) => v.name === 'poll')
    if (pollSpec === undefined) throw new Error('missing poll grammar')
    const answer = compileSpec(pollSpec).options.find((o) => o.names.includes('--answer'))
    expect(answer?.action).toBe('append')
    expect(answer?.required).toBe(true)
  })
})

describe('discord verbs', () => {
  it('send forwards --reply-to as a message reference', async () => {
    CALLS.length = 0
    await send(ACCESSOR, [], [], leafContext('send', { channel: 'C1', text: 're', reply_to: 'M0' }))
    expect(CALLS[0]?.body).toEqual({ content: 're', message_reference: { message_id: 'M0' } })
  })

  it('read sorts oldest-first', async () => {
    CALLS.length = 0
    RESPONSE = [{ id: '20' }, { id: '10' }]
    const [out] = unwrap(await read(ACCESSOR, [], [], leafContext('read', { channel: 'C1' })))
    expect(CALLS[0]?.params).toEqual({ limit: 20 })
    expect(
      (JSON.parse(DEC.decode(out as Uint8Array)) as { id: string }[]).map((m) => m.id),
    ).toEqual(['10', '20'])
    RESPONSE = { id: 'M1' }
  })

  it('delete DELETEs and reports ok', async () => {
    CALLS.length = 0
    RESPONSE = null
    const [out] = unwrap(
      await deleteVerb(ACCESSOR, [], [], leafContext('delete', { channel: 'C1', message: 'M1' })),
    )
    expect(CALLS[0]?.method).toBe('DELETE')
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ ok: true })
    RESPONSE = { id: 'M1' }
  })

  it('thread-create starts from a message when given', async () => {
    CALLS.length = 0
    await threadCreate(
      ACCESSOR,
      [],
      [],
      leafContext('thread-create', { channel: 'C1', name: 'topic', message: 'M1' }),
    )
    expect(CALLS[0]?.endpoint).toBe('/channels/C1/messages/M1/threads')
  })

  it('poll shapes the poll object with defaults', async () => {
    CALLS.length = 0
    await poll(
      ACCESSOR,
      [],
      [],
      leafContext('poll', { channel: 'C1', question: 'Lunch?', answer: ['A', 'B'] }),
    )
    expect(CALLS[0]?.body).toEqual({
      poll: {
        question: { text: 'Lunch?' },
        answers: [{ poll_media: { text: 'A' } }, { poll_media: { text: 'B' } }],
        duration: 24,
        allow_multiselect: false,
      },
    })
  })

  it('edit PATCHes the message text', async () => {
    CALLS.length = 0
    await edit(ACCESSOR, [], [], leafContext('edit', { channel: 'C1', message: 'M1', text: 'new' }))
    expect(CALLS[0]?.method).toBe('PATCH')
    expect(CALLS[0]?.endpoint).toBe('/channels/C1/messages/M1')
    expect(CALLS[0]?.body).toEqual({ content: 'new' })
  })

  it('react PUTs the encoded emoji', async () => {
    CALLS.length = 0
    await react(
      ACCESSOR,
      [],
      [],
      leafContext('react', { channel: 'C1', message: 'M1', emoji: 'x' }),
    )
    expect(CALLS[0]?.method).toBe('PUT')
    expect(CALLS[0]?.endpoint).toBe('/channels/C1/messages/M1/reactions/x/@me')
  })

  it('search forwards the channel filter', async () => {
    CALLS.length = 0
    RESPONSE = { messages: [[{ id: 'M1' }]], total_results: 1 }
    const [out] = unwrap(
      await search(
        ACCESSOR,
        [],
        [],
        leafContext('search', { guild: 'G1', query: 'q', channel: 'C1' }),
      ),
    )
    expect(CALLS[0]?.endpoint).toBe('/guilds/G1/messages/search')
    expect(CALLS[0]?.params).toMatchObject({ content: 'q', channel_id: 'C1' })
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual([{ id: 'M1' }])
    RESPONSE = { id: 'M1' }
  })

  it('members lists, or searches with --query', async () => {
    CALLS.length = 0
    RESPONSE = [{ user: { id: 'U1' } }]
    await members(ACCESSOR, [], [], leafContext('members', { guild: 'G1' }))
    await members(ACCESSOR, [], [], leafContext('members', { guild: 'G1', query: 'al' }))
    expect(CALLS.map((c) => c.endpoint)).toEqual([
      '/guilds/G1/members',
      '/guilds/G1/members/search',
    ])
    expect(CALLS[1]?.params).toMatchObject({ query: 'al' })
    RESPONSE = { id: 'M1' }
  })

  it('server-info GETs the guild', async () => {
    CALLS.length = 0
    RESPONSE = { id: 'G1' }
    const [out] = unwrap(
      await serverInfo(ACCESSOR, [], [], leafContext('server-info', { guild: 'G1' })),
    )
    expect(CALLS[0]?.endpoint).toBe('/guilds/G1')
    expect(JSON.parse(DEC.decode(out as Uint8Array))).toEqual({ id: 'G1' })
    RESPONSE = { id: 'M1' }
  })
})
