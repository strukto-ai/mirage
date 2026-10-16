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

import { guardDay } from '../time_range.ts'
import type { DiscordAccessor } from '../../accessor/discord.ts'
import { ContentType, DirListing, FileStat, FileType } from '../../types.ts'
import { contentTypeForMime } from '../../utils/filetype.ts'
import { makeReaddir, type Listed } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { listChannels } from './channels.ts'
import { DiscordApiError } from './client.ts'
import { channelEntry, guildEntry, historyEntry, memberEntry, snowflakeToDate } from './entry.ts'
import { fileBlobName, isListed } from './files.ts'
import { listGuilds } from './guilds.ts'
import { listMessagesForDay } from './history.ts'
import { listMembers } from './members.ts'
import { jsonlBytes } from '../render/json.ts'
import { detectScope } from './scope.ts'
import { globSpan, hasGlobSpan } from '../../utils/glob_walk.ts'

const SOFT_HTTP_STATUSES = new Set([403, 404, 429])

/**
 * The channel's day directories, newest first.
 *
 * A day dir is real for any well-formed date under the channel, so the bare
 * listing is a window: the last `days` up to the newest message. A glob names
 * its own window instead, clipped at the newest message because nothing was
 * posted after it.
 */
export function dateRangeDescending(
  endDate: string,
  days = 30,
  span: readonly [string, string] | null = null,
): string[] {
  const [y, m, d] = endDate.split('-').map((n) => Number.parseInt(n, 10))
  if (y === undefined || m === undefined || d === undefined) return []
  const dayMs = 86_400_000
  let end = Date.UTC(y, m - 1, d)
  let count = days
  if (span !== null) {
    const first = Date.parse(`${span[0]}T00:00:00Z`)
    end = Math.min(end, Date.parse(`${span[1]}T00:00:00Z`) - dayMs)
    count = Math.floor((end - first) / dayMs) + 1
    if (count <= 0) return []
  }
  const dates: string[] = []
  for (let i = 0; i < count; i++) {
    const cursor = new Date(end - i * dayMs)
    const yy = cursor.getUTCFullYear().toString().padStart(4, '0')
    const mm = (cursor.getUTCMonth() + 1).toString().padStart(2, '0')
    const dd = cursor.getUTCDate().toString().padStart(2, '0')
    dates.push(`${yy}-${mm}-${dd}`)
  }
  return dates
}

function todayUtc(): string {
  const now = new Date()
  const yyyy = now.getUTCFullYear().toString().padStart(4, '0')
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = now.getUTCDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function isSoftError(err: unknown): boolean {
  return err instanceof DiscordApiError && SOFT_HTTP_STATUSES.has(err.status)
}

function containerEntry(name: string, guildId: string): FileStat {
  return new FileStat({ name, type: FileType.DIRECTORY, extra: { guild_id: guildId } })
}

async function listRoot(accessor: DiscordAccessor, _match: ScopeMatch): Promise<Listed | null> {
  return (await listGuilds(accessor)).map(guildEntry)
}

function listGuildContainers(
  _accessor: DiscordAccessor,
  _match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  const guildId = String(own.extra.guild_id)
  return Promise.resolve([containerEntry('channels', guildId), containerEntry('members', guildId)])
}

async function listChannelsDir(
  accessor: DiscordAccessor,
  _match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  return (await listChannels(accessor, String(own.extra.guild_id))).map(channelEntry)
}

async function listMembersDir(
  accessor: DiscordAccessor,
  _match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  const members = await listMembers(accessor, String(own.extra.guild_id))
  return members.filter((m) => m.user !== undefined && m.user.id !== '').map(memberEntry)
}

function listChannelDays(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  const channelId = String(own.extra.channel_id)
  const lastMsgId = typeof own.extra.last_message_id === 'string' ? own.extra.last_message_id : ''
  const endDate = lastMsgId !== '' ? snowflakeToDate(lastMsgId) : todayUtc()
  const span = globSpan(match.pattern)
  const dates = accessor.timeRange.bounded
    ? accessor.timeRange.listingDays(snowflakeToDate(channelId), endDate, span)
    : dateRangeDescending(endDate, 30, span)
  return Promise.resolve(
    new DirListing({
      entries: dates.map((d) => historyEntry(channelId, d)),
      partial: span !== null,
      window: true,
    }),
  )
}

/**
 * One history fetch, answering the day dir and its files subdir.
 *
 * A soft HTTP error (403/404/429) seals an empty day: the dir lists nothing,
 * and stat serves chat.jsonl with the size left unknown.
 */
async function dayListing(
  accessor: DiscordAccessor,
  channelId: string,
  dateStr: string,
): Promise<DirListing> {
  let messages
  try {
    messages = await listMessagesForDay(accessor, channelId, dateStr)
  } catch (e) {
    // A soft error is not the channel saying the day's messages are gone,
    // so the empty day must not evict what it held.
    if (isSoftError(e)) return new DirListing({ entries: [], window: true })
    throw e
  }
  // The day's messages are already in hand, so chat.jsonl's exact rendered
  // size is free here; read() renders the same messages the same way.
  const blobs: FileStat[] = []
  for (const msg of messages) {
    const atts = (msg.attachments ?? []) as {
      id: string
      filename?: string
      url?: string
      proxy_url?: string
      content_type?: string
      size?: number
    }[]
    for (const att of atts) {
      if (!isListed(att)) continue
      const mimetype = att.content_type ?? ''
      blobs.push(
        new FileStat({
          name: fileBlobName(att),
          type: FileType.FILE,
          content: contentTypeForMime(mimetype),
          size: att.size,
          extra: {
            attachment_id: att.id,
            content_type: mimetype,
            url: att.url,
            proxy_url: att.proxy_url ?? '',
            message_id: msg.id,
            author: (msg.author as { username?: string } | undefined)?.username ?? '',
            channel_id: channelId,
            date: dateStr,
          },
        }),
      )
    }
  }
  return new DirListing({
    entries: [
      new FileStat({
        name: 'chat.jsonl',
        type: FileType.FILE,
        content: ContentType.TEXT,
        size: jsonlBytes(messages).byteLength,
        extra: { channel_id: channelId },
      }),
      new FileStat({
        name: 'files',
        type: FileType.DIRECTORY,
        extra: { channel_id: channelId, date: dateStr },
      }),
    ],
    seeds: new Map([['files', blobs]]),
  })
}

function listDay(accessor: DiscordAccessor, match: ScopeMatch, own: FileStat): Promise<Listed> {
  // The day's row carries its channel: one the bounded window lists, or one
  // stat makes for any well-formed date under a real channel, so a date
  // outside the window fetches too.
  return dayListing(accessor, String(own.extra.channel_id), match.slots.day ?? '')
}

export async function listFiles(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  // Normally served from the day lister's seed; reached only when the index
  // evicted the files listing while the day's rows survived.
  const listing = await dayListing(accessor, String(own.extra.channel_id), match.slots.day ?? '')
  // A soft-error day proves nothing about its attachments either.
  return new DirListing({
    entries: [...(listing.seeds.get('files') ?? [])],
    window: listing.window,
  })
}

export const readdir = makeReaddir<DiscordAccessor>(detectScope, {
  listers: { root: listRoot },
  entryListers: {
    guild: listGuildContainers,
    channels_dir: listChannelsDir,
    members_dir: listMembersDir,
    channel: listChannelDays,
    day: listDay,
    files: listFiles,
  },
  guards: { day: guardDay, files: guardDay },
  patternKinds: { channel: hasGlobSpan },
  leafError: 'enotdir',
})
