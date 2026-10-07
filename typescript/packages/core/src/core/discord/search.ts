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

import { PathSpec } from '../../types.ts'
import type { SearchResult } from '../../vfs/types.ts'
import type { DiscordAccessor } from '../../accessor/discord.ts'
import { channelDirname, guildDirname } from './entry.ts'
import { offsetPages } from './paginate.ts'
import { snowflakeToIso } from './entry.ts'

const PAGE_SIZE = 25

export type DiscordSearchMessage = Record<string, unknown> & { id?: string }

function flattenContexts(contexts: DiscordSearchMessage[][]): DiscordSearchMessage[] {
  const out: DiscordSearchMessage[] = []
  for (const ctx of contexts) {
    if (ctx.length > 0 && ctx[0] !== undefined) out.push(ctx[0])
  }
  return out
}

async function* searchGuildStream(
  accessor: DiscordAccessor,
  guildId: string,
  query: string,
  channelId?: string,
  maxPages?: number,
): AsyncIterableIterator<DiscordSearchMessage[]> {
  const baseParams: Record<string, string | number> = { content: query }
  if (channelId !== undefined && channelId !== '') baseParams.channel_id = channelId
  for await (const raw of offsetPages<DiscordSearchMessage[]>(accessor, {
    endpoint: `/guilds/${guildId}/messages/search`,
    baseParams,
    itemsPath: ['messages'],
    totalKey: 'total_results',
    pageSize: PAGE_SIZE,
    ...(maxPages !== undefined ? { maxPages } : {}),
  })) {
    const flat = flattenContexts(raw)
    if (flat.length > 0) yield flat
  }
}

export async function searchGuild(
  accessor: DiscordAccessor,
  guildId: string,
  query: string,
  channelId?: string,
  limit = 100,
): Promise<DiscordSearchMessage[]> {
  const messages: DiscordSearchMessage[] = []
  for await (const page of searchGuildStream(accessor, guildId, query, channelId)) {
    for (const msg of page) {
      messages.push(msg)
      if (messages.length >= limit) break
    }
    if (messages.length >= limit) break
  }
  messages.sort((a, b) => {
    const ai = BigInt(a.id ?? '0')
    const bi = BigInt(b.id ?? '0')
    return ai < bi ? -1 : ai > bi ? 1 : 0
  })
  return messages.slice(0, limit)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export interface SearchScope {
  guildId: string
  guildName?: string
  channelName?: string
}

export function formatGrepResults(
  messages: readonly DiscordSearchMessage[],
  scope: SearchScope,
  prefix: string,
  channelNames: ReadonlyMap<string, string> = new Map(),
): SearchResult[] {
  const guildId = scope.guildId
  const guildVfs = guildDirname({
    id: guildId,
    ...(scope.guildName !== undefined ? { name: scope.guildName } : {}),
  })
  const lines: SearchResult[] = []
  for (const msg of messages) {
    let ts = asString(msg.timestamp).slice(0, 10)
    if (ts === '') {
      // A hit without a timestamp still has a snowflake id, which encodes
      // the creation day readdir buckets it under.
      const iso = snowflakeToIso(asString(msg.id))
      ts = iso !== null ? iso.slice(0, 10) : ''
    }
    const chId = asString(msg.channel_id)
    const chName = channelNames.get(chId) ?? scope.channelName ?? ''
    const chVfs = channelDirname({ id: chId, ...(chName !== '' ? { name: chName } : {}) })
    const author = (msg.author as { username?: string } | undefined)?.username ?? '?'
    const content = asString(msg.content).replace(/\n/g, ' ')
    const path =
      ts !== ''
        ? `${prefix}/${guildVfs}/channels/${chVfs}/${ts}/chat.jsonl`
        : `${prefix}/${guildVfs}/channels/${chVfs}`
    lines.push([
      PathSpec.fromStrPath(path, path.slice(prefix.length).replace(/^\//, '')),
      `${path}:[${author}] ${content}`,
    ])
  }
  return lines
}
