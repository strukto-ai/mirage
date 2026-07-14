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

export const DISCORD_EPOCH = 1420070400000n

export function dateToSnowflake(dateStr: string, endOfDay = false): string {
  const parts = dateStr.split('-')
  if (parts.length !== 3) throw new Error(`invalid date: ${dateStr}`)
  const y = Number.parseInt(parts[0] ?? '', 10)
  const m = Number.parseInt(parts[1] ?? '', 10)
  const d = Number.parseInt(parts[2] ?? '', 10)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`invalid date: ${dateStr}`)
  }
  const ms = endOfDay ? Date.UTC(y, m - 1, d, 23, 59, 59) : Date.UTC(y, m - 1, d, 0, 0, 0)
  if (!Number.isFinite(ms)) throw new Error(`invalid date: ${dateStr}`)
  const offset = BigInt(ms) - DISCORD_EPOCH
  return (offset << 22n).toString()
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
  const after = dateToSnowflake(dateStr, false)
  const beforeBig = BigInt(dateToSnowflake(dateStr, true))
  for await (const page of afterIdPages<DiscordMessage>(accessor, {
    endpoint: `/channels/${channelId}/messages`,
    lastIdFn: (m) => (m as DiscordMessage).id,
    pageSize,
    startAfter: after,
  })) {
    const inRange = page.filter((m) => BigInt(m.id) <= beforeBig)
    if (inRange.length > 0) yield inRange
    if (page.some((m) => BigInt(m.id) > beforeBig)) return
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
  if (messages.length === 0) return new Uint8Array()
  const lines = messages.map((m) => JSON.stringify(m))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}
