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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { DAY, DiscordGuild, GENERAL, MESSAGE, MESSAGES } from '../../../tests/core/discord/guild.ts'
import { deleteMessage, editMessage, sendMessage, sendPoll } from './post.ts'

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

describe('sendMessage', () => {
  it('POSTs to /channels/<id>/messages with content body', async () => {
    const out = (await sendMessage(guild.accessor(), GENERAL, 'hello')) as { id: string }
    expect(await guild.run.bodies('POST', MESSAGES)).toEqual([{ content: 'hello' }])
    expect(await guild.run.params('POST', MESSAGES)).toEqual([{}])
    expect((await guild.message(GENERAL, out.id)).content).toBe('hello')
  })

  it('adds message_reference when messageReferenceId is provided', async () => {
    const id = await hello()
    await sendMessage(guild.accessor(), GENERAL, 'reply', id)
    expect(await guild.run.bodies('POST', MESSAGES)).toEqual([
      { content: 'reply', message_reference: { message_id: id } },
    ])
  })

  it('posts a file as multipart through the transport', async () => {
    const file = { name: 'reply.wav', data: new TextEncoder().encode('RIFF') }
    const out = (await sendMessage(guild.accessor(), GENERAL, '', undefined, file)) as {
      id: string
    }
    const [attached] = (await guild.message(GENERAL, out.id)).attachments as {
      filename: string
      url: string
    }[]
    expect(attached?.filename).toBe('reply.wav')
    const path = (attached?.url ?? '').split('/attachments/')[1]?.split('?')[0] ?? ''
    expect(await guild.run.read(`/attachments/${path}`)).toEqual(file.data)
  })

  it('omits message_reference when messageReferenceId is empty string', async () => {
    await sendMessage(guild.accessor(), GENERAL, 'hi', '')
    expect(await guild.run.bodies('POST', MESSAGES)).toEqual([{ content: 'hi' }])
  })
})

describe('editMessage / deleteMessage / sendPoll', () => {
  it('editMessage PATCHes the message content', async () => {
    // A bot may edit only what it posted.
    const mine = await guild.post(GENERAL, 'draft')
    await editMessage(guild.accessor(), GENERAL, mine.id, 'edited')
    expect(await guild.run.bodies('PATCH', MESSAGE)).toEqual([{ content: 'edited' }])
    expect((await guild.message(GENERAL, mine.id)).content).toBe('edited')
  })

  it('deleteMessage DELETEs the message', async () => {
    const mine = await guild.post(GENERAL, 'gone soon')
    await deleteMessage(guild.accessor(), GENERAL, mine.id)
    expect(await guild.count(MESSAGE, 'DELETE')).toBe(1)
    const gone = await guild.run.request('GET', `/api/v10/channels/${GENERAL}/messages/${mine.id}`)
    expect(gone.status).toBe(404)
    await gone.text()
  })

  it('sendPoll shapes the poll object', async () => {
    await sendPoll(guild.accessor(), GENERAL, 'Lunch?', ['Pizza', 'Sushi'], 48, true)
    expect(await guild.run.bodies('POST', MESSAGES)).toEqual([
      {
        poll: {
          question: { text: 'Lunch?' },
          answers: [{ poll_media: { text: 'Pizza' } }, { poll_media: { text: 'Sushi' } }],
          duration: 48,
          allow_multiselect: true,
        },
      },
    ])
  })
})
