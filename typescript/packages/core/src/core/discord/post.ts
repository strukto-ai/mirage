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

import type { DiscordAccessor } from '../../accessor/discord.ts'

export async function sendMessage(
  accessor: DiscordAccessor,
  channelId: string,
  text: string,
  messageReferenceId?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { content: text }
  if (messageReferenceId !== undefined && messageReferenceId !== '') {
    body.message_reference = { message_id: messageReferenceId }
  }
  return accessor.transport.call('POST', `/channels/${channelId}/messages`, undefined, body)
}

export async function editMessage(
  accessor: DiscordAccessor,
  channelId: string,
  messageId: string,
  text: string,
): Promise<unknown> {
  return accessor.transport.call(
    'PATCH',
    `/channels/${channelId}/messages/${messageId}`,
    undefined,
    {
      content: text,
    },
  )
}

export async function deleteMessage(
  accessor: DiscordAccessor,
  channelId: string,
  messageId: string,
): Promise<void> {
  await accessor.transport.call('DELETE', `/channels/${channelId}/messages/${messageId}`)
}

export async function sendPoll(
  accessor: DiscordAccessor,
  channelId: string,
  question: string,
  answers: readonly string[],
  durationHours = 24,
  multiselect = false,
): Promise<unknown> {
  return accessor.transport.call('POST', `/channels/${channelId}/messages`, undefined, {
    poll: {
      question: { text: question },
      answers: answers.map((answer) => ({ poll_media: { text: answer } })),
      duration: durationHours,
      allow_multiselect: multiselect,
    },
  })
}
