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
import { soleCommandStarted } from '../../cache/index/scope.ts'
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

/**
 * A channel-day's messages, or a run of days' through `lastDay`, a page at a
 * time, newest page first. Mirrors Python's `stream_messages_for_day`.
 */
export async function* streamMessagesForDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
  pageSize = 100,
  after?: string,
  lastDay?: string,
): AsyncIterableIterator<DiscordMessage[]> {
  const [start] = accessor.timeRange.dayBounds(dateStr)
  const [, end] = accessor.timeRange.dayBounds(lastDay ?? dateStr)
  if (start >= end) return
  const first = snowflakeAt(start)
  const beforeBig = snowflakeAt(end)
  let floor = first > 0n ? first - 1n : 0n
  if (after !== undefined && BigInt(after) > floor) floor = BigInt(after)
  for await (const page of afterIdPages<DiscordMessage>(accessor, {
    endpoint: `/channels/${channelId}/messages`,
    lastIdFn: (m) => (m as DiscordMessage).id,
    pageSize,
    startAfter: floor.toString(),
    newestFirst: true,
  })) {
    const inRange = page.filter((m) => BigInt(m.id) >= first && BigInt(m.id) < beforeBig)
    if (inRange.length > 0) yield inRange
    if (page.some((m) => BigInt(m.id) >= beforeBig)) return
  }
}

/** Every message of a channel-day, or only those after `after`, oldest first. */
export async function listMessagesForDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
  pageSize = 100,
  after?: string,
): Promise<DiscordMessage[]> {
  const out: DiscordMessage[] = []
  for await (const page of streamMessagesForDay(accessor, channelId, dateStr, pageSize, after)) {
    for (const item of page) out.push(item)
  }
  out.sort((a, b) => {
    const ai = BigInt(a.id)
    const bi = BigInt(b.id)
    return ai < bi ? -1 : ai > bi ? 1 : 0
  })
  return out
}

/**
 * A channel-day's messages: the ones the running command already fetched,
 * else fetched now and kept for that command. Outside any command nothing
 * is kept, since no command bounds how long the day would be served.
 * Mirrors Python's `_kept_day`.
 */
async function keptDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
): Promise<DiscordMessage[]> {
  const fetch = () => listMessagesForDay(accessor, channelId, dateStr)
  const started = soleCommandStarted()
  if (started === null) return fetch()
  return (await accessor.listedDay.get(
    `${String(started)}/${channelId}/${dateStr}`,
    fetch,
  )) as DiscordMessage[]
}

/**
 * A channel-day's messages for its listing, kept for the read of its
 * chat.jsonl that follows in the same command. A walk reads a day's
 * chat.jsonl right after it lists the day, so only the last listed day is
 * kept, only for the command that listed it, and for at most
 * `LISTING_TRUST_WINDOW` seconds, the window a fetch still counts as current
 * in (none under `fresh`). That command's read takes it instead of fetching
 * the day again; any other read, a direct one included, asks Discord. A
 * listing nothing reads holds no more than one day. Mirrors Python's
 * `listed_messages_for_day`.
 */
export async function listedMessagesForDay(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
): Promise<DiscordMessage[]> {
  accessor.listedDay.clear()
  return keptDay(accessor, channelId, dateStr)
}

/**
 * A channel-day's messages as JSONL: the ones the running command's listing
 * of the day just fetched (`listedMessagesForDay`), else fetched now. Either
 * way the day is no longer kept. Mirrors Python's `get_history_jsonl`.
 */
export async function getHistoryJsonl(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
): Promise<Uint8Array> {
  const messages = await keptDay(accessor, channelId, dateStr)
  accessor.listedDay.clear()
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
