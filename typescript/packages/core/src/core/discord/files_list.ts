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
import type { DiscordAttachment } from './files.ts'
import { type DiscordMessage, streamMessagesForDay } from './history.ts'

export interface DiscordAttachmentMeta extends DiscordAttachment {
  _date: string
  _channel_id: string
  _message_id: string
  _author: string
}

function attachMeta(
  att: DiscordAttachment,
  msg: DiscordMessage,
  dateStr: string,
  channelId: string,
): DiscordAttachmentMeta {
  const author = (msg.author as { username?: string } | undefined)?.username ?? '?'
  return {
    ...att,
    _date: dateStr,
    _channel_id: channelId,
    _message_id: msg.id,
    _author: author,
  }
}

export async function* listFilesForDayStream(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
): AsyncIterableIterator<DiscordAttachmentMeta[]> {
  for await (const page of streamMessagesForDay(accessor, channelId, dateStr)) {
    const atts: DiscordAttachmentMeta[] = []
    for (const msg of page) {
      for (const att of msg.attachments ?? []) {
        atts.push(attachMeta(att as DiscordAttachment, msg, dateStr, channelId))
      }
    }
    if (atts.length > 0) yield atts
  }
}

export async function listFilesForDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
): Promise<DiscordAttachmentMeta[]> {
  const out: DiscordAttachmentMeta[] = []
  for await (const page of listFilesForDayStream(accessor, channelId, dateStr)) {
    out.push(...page)
  }
  return out
}
