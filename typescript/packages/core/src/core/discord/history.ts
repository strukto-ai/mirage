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
import { afterIdPages } from './paginate.ts'
import { jsonlBytes } from '../render/json.ts'

export const DISCORD_EPOCH = 1420070400000n

/** The lowest snowflake Discord mints at `seconds` of Unix time. */
export function snowflakeAt(seconds: number): bigint {
  return (BigInt(Math.round(seconds * 1000)) - DISCORD_EPOCH) << 22n
}

export interface DiscordMessage extends Record<string, unknown> {
  id: string
  attachments?: { id: string; [key: string]: unknown }[]
}

async function* streamMessagesForDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
  pageSize = 100,
): AsyncIterableIterator<DiscordMessage[]> {
  const [start, end] = accessor.timeRange.dayBounds(dateStr)
  if (start >= end) return
  const first = snowflakeAt(start)
  const beforeBig = snowflakeAt(end)
  const after = (first > 0n ? first - 1n : 0n).toString()
  for await (const page of afterIdPages<DiscordMessage>(accessor, {
    endpoint: `/channels/${channelId}/messages`,
    lastIdFn: (m) => (m as DiscordMessage).id,
    pageSize,
    startAfter: after,
    newestFirst: true,
  })) {
    const inRange = page.filter((m) => BigInt(m.id) >= first && BigInt(m.id) < beforeBig)
    if (inRange.length > 0) yield inRange
    if (page.some((m) => BigInt(m.id) >= beforeBig)) return
  }
}

export async function listMessagesForDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
  pageSize = 100,
): Promise<DiscordMessage[]> {
  const out: DiscordMessage[] = []
  for await (const page of streamMessagesForDay(accessor, channelId, dateStr, pageSize)) {
    out.push(...page)
  }
  out.sort((a, b) => {
    const ai = BigInt(a.id)
    const bi = BigInt(b.id)
    return ai < bi ? -1 : ai > bi ? 1 : 0
  })
  return out
}

export async function getHistoryJsonl(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
): Promise<Uint8Array> {
  const messages = await listMessagesForDay(accessor, channelId, dateStr)
  return jsonlBytes(messages)
}

export async function fetchRecentMessages(
  accessor: DiscordAccessor,
  channelId: string,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const page = await accessor.transport.call('GET', `/channels/${channelId}/messages`, { limit })
  const items = Array.isArray(page)
    ? page.filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
    : []
  items.sort((a, b) => {
    const ai = BigInt(typeof a.id === 'string' ? a.id : '0')
    const bi = BigInt(typeof b.id === 'string' ? b.id : '0')
    return ai < bi ? -1 : ai > bi ? 1 : 0
  })
  return items
}
