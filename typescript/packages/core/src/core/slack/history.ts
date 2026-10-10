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

import type { SlackAccessor } from '../../accessor/slack.ts'
import { jsonlBytes } from '../render/json.ts'
import { cursorPages } from './paginate.ts'

export interface SlackMessage {
  ts: string
  user?: string
  text?: string
  thread_ts?: string
  [key: string]: unknown
}

export async function* streamMessagesForDay(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
  options: { limit?: number } = {},
): AsyncIterableIterator<SlackMessage[]> {
  const limit = options.limit ?? 200
  const [oldest, latest] = accessor.timeRange.dayBounds(dateStr)
  if (oldest >= latest) return
  for await (const page of cursorPages<SlackMessage>(
    accessor.transport,
    'conversations.history',
    {
      channel: channelId,
      oldest: oldest.toFixed(6),
      latest: latest.toFixed(6),
      limit: String(limit),
      inclusive: 'true',
    },
    'messages',
  )) {
    yield page.filter((message) => Number(message.ts) >= oldest && Number(message.ts) < latest)
  }
}

export async function fetchMessagesForDay(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = []
  for await (const page of streamMessagesForDay(accessor, channelId, dateStr)) {
    messages.push(...page)
  }
  messages.sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts))
  return messages
}

export async function getHistoryJsonl(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
): Promise<Uint8Array> {
  const messages = await fetchMessagesForDay(accessor, channelId, dateStr)
  return jsonlBytes(messages)
}

export async function fetchRecentMessages(
  accessor: SlackAccessor,
  channelId: string,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const data = await accessor.transport.call('conversations.history', {
    channel: channelId,
    limit: String(limit),
  })
  const messages = Array.isArray(data.messages) ? (data.messages as Record<string, unknown>[]) : []
  messages.sort(
    (a, b) =>
      parseFloat(typeof a.ts === 'string' ? a.ts : '0') -
      parseFloat(typeof b.ts === 'string' ? b.ts : '0'),
  )
  return messages
}
