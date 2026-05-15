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
import { cursorPages } from './paginate.ts'

export interface SlackMessage {
  ts: string
  user?: string
  text?: string
  thread_ts?: string
  [key: string]: unknown
}

const encoder = new TextEncoder()

function dayBoundsUtc(dateStr: string): { oldest: string; latest: string } {
  const parts = dateStr.split('-').map((s) => Number.parseInt(s, 10))
  const y = parts[0]
  const m = parts[1]
  const d = parts[2]
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d)
  ) {
    throw new Error(`Invalid date_str: ${dateStr}`)
  }
  const start = Date.UTC(y, m - 1, d, 0, 0, 0) / 1000
  const end = Date.UTC(y, m - 1, d, 23, 59, 59) / 1000
  return { oldest: String(start), latest: String(end) }
}

export function streamMessagesForDay(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
  options: { limit?: number } = {},
): AsyncIterableIterator<SlackMessage[]> {
  const limit = options.limit ?? 200
  const { oldest, latest } = dayBoundsUtc(dateStr)
  return cursorPages<SlackMessage>(
    accessor.transport,
    'conversations.history',
    {
      channel: channelId,
      oldest,
      latest,
      limit: String(limit),
      inclusive: 'true',
    },
    'messages',
  )
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
  if (messages.length === 0) return new Uint8Array(0)
  const lines = messages.map((m) => JSON.stringify(m))
  return encoder.encode(lines.join('\n') + '\n')
}

export function streamThreadReplies(
  accessor: SlackAccessor,
  channelId: string,
  threadTs: string,
  options: { limit?: number } = {},
): AsyncIterableIterator<SlackMessage[]> {
  const limit = options.limit ?? 200
  return cursorPages<SlackMessage>(
    accessor.transport,
    'conversations.replies',
    {
      channel: channelId,
      ts: threadTs,
      limit: String(limit),
    },
    'messages',
  )
}

export async function getThreadJsonl(
  accessor: SlackAccessor,
  channelId: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const replies: SlackMessage[] = []
  for await (const page of streamThreadReplies(accessor, channelId, threadTs)) {
    replies.push(...page)
  }
  return replies
}
