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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { discordAccessor } from '../../../../accessor/discord.ts'
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
import { context } from '../../../../../tests/workspace/fixtures/context.ts'
import { serve } from '../../../../../tests/fixtures/kit_fake.ts'
import {
  DAY,
  DiscordGuild,
  FROM_MESSAGE,
  GENERAL,
  GUILD,
  MESSAGE,
  MESSAGES,
  SEARCH,
} from '../../../../../tests/core/discord/guild.ts'
import type { FlagValue } from '../../../spec/types.ts'

function leafContext(leaf: string, flags: Record<string, FlagValue> = {}): Context {
  const spec = DISCORD.spec.subcommands.find((s) => s.name === leaf)
  if (spec === undefined) throw new Error(`no discord leaf ${leaf}`)
  return context({ flags, spec })
}

const DEC = new TextDecoder()

let origin = ''
let guild: DiscordGuild

beforeAll(async () => {
  origin = await serve('discord')
})

beforeEach(async () => {
  guild = new DiscordGuild(origin)
  await guild.reset()
})

afterEach(async () => {
  await guild.close()
})

async function hello(): Promise<string> {
  return (await guild.day(GENERAL, DAY))[0]?.id ?? ''
}

function json(out: ByteSource | null): unknown {
  return JSON.parse(DEC.decode(out as Uint8Array))
}

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
  'reactions',
  'pin-message',
  'unpin-message',
  'list-pins',
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
    expect(writers).toEqual(
      new Set([
        'send',
        'edit',
        'delete',
        'react',
        'pin-message',
        'unpin-message',
        'thread-create',
        'poll',
      ]),
    )
    const pollSpec = DISCORD.spec.subcommands.find((v) => v.name === 'poll')
    if (pollSpec === undefined) throw new Error('missing poll grammar')
    const answer = compileSpec(pollSpec).options.find((o) => o.names.includes('--answer'))
    expect(answer?.action).toBe('append')
    expect(answer?.required).toBe(true)
  })
})

describe('discord verbs', () => {
  it('send forwards --reply-to as a message reference', async () => {
    const id = await hello()
    await send(
      guild.accessor(),
      [],
      [],
      leafContext('send', { channel: GENERAL, text: 're', reply_to: id }),
    )
    expect(await guild.run.bodies('POST', MESSAGES)).toEqual([
      { content: 're', message_reference: { message_id: id } },
    ])
  })

  it('read sorts oldest-first', async () => {
    const [out] = unwrap(
      await read(guild.accessor(), [], [], leafContext('read', { channel: GENERAL })),
    )
    expect(await guild.run.params('GET', MESSAGES)).toEqual([{ limit: '20' }])
    expect((json(out) as { content: string }[]).map((m) => m.content)).toEqual([
      'hello',
      'files',
      'morning',
    ])
  })

  it('delete DELETEs and reports ok', async () => {
    // A bot may delete only what it posted.
    const mine = await guild.post(GENERAL, 'gone soon')
    const [out] = unwrap(
      await deleteVerb(
        guild.accessor(),
        [],
        [],
        leafContext('delete', { channel: GENERAL, message: mine.id }),
      ),
    )
    expect(await guild.count(MESSAGE, 'DELETE')).toBe(1)
    expect(json(out)).toEqual({ ok: true })
  })

  it('thread-create starts from a message when given', async () => {
    const id = await hello()
    await threadCreate(
      guild.accessor(),
      [],
      [],
      leafContext('thread-create', { channel: GENERAL, name: 'topic', message: id }),
    )
    expect(await guild.run.bodies('POST', FROM_MESSAGE)).toEqual([{ name: 'topic' }])
  })

  it('poll shapes the poll object with defaults', async () => {
    await poll(
      guild.accessor(),
      [],
      [],
      leafContext('poll', { channel: GENERAL, question: 'Lunch?', answer: ['A', 'B'] }),
    )
    expect(await guild.run.bodies('POST', MESSAGES)).toEqual([
      {
        poll: {
          question: { text: 'Lunch?' },
          answers: [{ poll_media: { text: 'A' } }, { poll_media: { text: 'B' } }],
          duration: 24,
          allow_multiselect: false,
        },
      },
    ])
  })

  it('edit PATCHes the message text', async () => {
    // A bot may edit only what it posted.
    const mine = await guild.post(GENERAL, 'draft')
    await edit(
      guild.accessor(),
      [],
      [],
      leafContext('edit', { channel: GENERAL, message: mine.id, text: 'new' }),
    )
    expect(await guild.run.bodies('PATCH', MESSAGE)).toEqual([{ content: 'new' }])
    expect((await guild.message(GENERAL, mine.id)).content).toBe('new')
  })

  it('react PUTs the encoded emoji', async () => {
    const id = await hello()
    await react(
      guild.accessor(),
      [],
      [],
      leafContext('react', { channel: GENERAL, message: id, emoji: 'x' }),
    )
    expect(await guild.run.requests()).toEqual([
      `PUT /api/v10/channels/${GENERAL}/messages/${id}/reactions/x/@me`,
    ])
  })

  it('search forwards the channel filter', async () => {
    const [out] = unwrap(
      await search(
        guild.accessor(),
        [],
        [],
        leafContext('search', { guild: GUILD, query: 'o', channel: GENERAL }),
      ),
    )
    expect((await guild.run.params('GET', SEARCH))[0]).toMatchObject({
      content: 'o',
      channel_id: GENERAL,
    })
    // random's chatter matches too, outside the channel asked for.
    expect((json(out) as { content: string }[]).map((m) => m.content)).toEqual(['hello', 'morning'])
  })

  it('members lists, or searches with --query', async () => {
    const accessor = guild.accessor()
    await members(accessor, [], [], leafContext('members', { guild: GUILD }))
    await members(accessor, [], [], leafContext('members', { guild: GUILD, query: 'al' }))
    const asked = (await guild.run.requests()).map((r) => r.split(' ')[1]?.split('?')[0])
    expect(asked).toEqual([
      `/api/v10/guilds/${GUILD}/members`,
      `/api/v10/guilds/${GUILD}/members/search`,
    ])
    expect(
      (await guild.run.params('GET', '/api/v10/guilds/:guild_id/members/search'))[0],
    ).toMatchObject({
      query: 'al',
    })
  })

  it('server-info GETs the guild', async () => {
    const [out] = unwrap(
      await serverInfo(guild.accessor(), [], [], leafContext('server-info', { guild: GUILD })),
    )
    expect(await guild.run.requests()).toEqual([`GET /api/v10/guilds/${GUILD}`])
    expect((json(out) as { id: string }).id).toBe(GUILD)
  })
})
