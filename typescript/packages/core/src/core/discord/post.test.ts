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
import { DiscordAccessor } from '../../accessor/discord.ts'
import type { DiscordMethod, DiscordResponse, DiscordTransport } from './_client.ts'
import { deleteMessage, editMessage, sendMessage, sendPoll } from './post.ts'

interface RecordedCall {
  method: DiscordMethod
  endpoint: string
  params?: Record<string, string | number>
  body?: Record<string, unknown>
}

class FakeDiscordTransport implements DiscordTransport {
  public readonly calls: RecordedCall[] = []
  constructor(private readonly responder: () => DiscordResponse = () => ({ id: 'M1' })) {}
  call(
    method: DiscordMethod,
    endpoint: string,
    params?: Record<string, string | number>,
    body?: Record<string, unknown>,
  ): Promise<DiscordResponse> {
    this.calls.push({
      method,
      endpoint,
      ...(params !== undefined ? { params } : {}),
      ...(body !== undefined ? { body } : {}),
    })
    return Promise.resolve(this.responder())
  }
}

describe('sendMessage', () => {
  it('POSTs to /channels/<id>/messages with content body', async () => {
    const t = new FakeDiscordTransport(() => ({ id: 'M1' }))
    const out = await sendMessage(new DiscordAccessor(t), 'C1', 'hello')
    expect(t.calls[0]?.method).toBe('POST')
    expect(t.calls[0]?.endpoint).toBe('/channels/C1/messages')
    expect(t.calls[0]?.params).toBeUndefined()
    expect(t.calls[0]?.body).toEqual({ content: 'hello' })
    expect(out).toMatchObject({ id: 'M1' })
  })

  it('adds message_reference when messageReferenceId is provided', async () => {
    const t = new FakeDiscordTransport()
    await sendMessage(new DiscordAccessor(t), 'C1', 'reply', 'M0')
    expect(t.calls[0]?.body).toEqual({
      content: 'reply',
      message_reference: { message_id: 'M0' },
    })
  })

  it('omits message_reference when messageReferenceId is empty string', async () => {
    const t = new FakeDiscordTransport()
    await sendMessage(new DiscordAccessor(t), 'C1', 'hi', '')
    expect(t.calls[0]?.body).toEqual({ content: 'hi' })
  })
})

describe('editMessage / deleteMessage / sendPoll', () => {
  it('editMessage PATCHes the message content', async () => {
    const t = new FakeDiscordTransport()
    await editMessage(new DiscordAccessor(t), 'C1', 'M1', 'edited')
    expect(t.calls[0]?.method).toBe('PATCH')
    expect(t.calls[0]?.endpoint).toBe('/channels/C1/messages/M1')
    expect(t.calls[0]?.body).toEqual({ content: 'edited' })
  })

  it('deleteMessage DELETEs the message', async () => {
    const t = new FakeDiscordTransport()
    await deleteMessage(new DiscordAccessor(t), 'C1', 'M1')
    expect(t.calls[0]?.method).toBe('DELETE')
    expect(t.calls[0]?.endpoint).toBe('/channels/C1/messages/M1')
  })

  it('sendPoll shapes the poll object', async () => {
    const t = new FakeDiscordTransport()
    await sendPoll(new DiscordAccessor(t), 'C1', 'Lunch?', ['Pizza', 'Sushi'], 48, true)
    expect(t.calls[0]?.body).toEqual({
      poll: {
        question: { text: 'Lunch?' },
        answers: [{ poll_media: { text: 'Pizza' } }, { poll_media: { text: 'Sushi' } }],
        duration: 48,
        allow_multiselect: true,
      },
    })
  })
})
