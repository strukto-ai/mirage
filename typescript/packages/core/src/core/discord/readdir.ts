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
import { IndexEntry } from '../../cache/index/config.ts'
import { makeReaddir, type DirListing, type Listed } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { listChannels } from './channels.ts'
import { DiscordApiError } from './client.ts'
import { DiscordIndexEntry, DiscordResourceType } from './entry.ts'
import { fileBlobName } from './files.ts'
import { listGuilds } from './guilds.ts'
import { listMessagesForDay } from './history.ts'
import { listMembers } from './members.ts'
import { historyJsonlBytes, memberJsonBytes } from './render.ts'
import { detectScope } from './scope.ts'
import { globSpan, hasGlobSpan } from '../../utils/glob_walk.ts'
import { snowflakeToDate } from './entry.ts'

const SOFT_STATUSES = new Set([403, 404, 429])

const CONTAINER_TYPE = 'discord/container'

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
  return err instanceof DiscordApiError && SOFT_STATUSES.has(err.status)
}

function containerEntry(name: string, guildId: string): IndexEntry {
  return new IndexEntry({
    id: guildId,
    name,
    resourceType: CONTAINER_TYPE,
    vfsName: name,
  })
}

async function listRoot(accessor: DiscordAccessor, _match: ScopeMatch): Promise<Listed | null> {
  const guilds = await listGuilds(accessor)
  return guilds.map((g) => {
    const entry = DiscordIndexEntry.guild(g)
    return [entry.vfsName, entry] as [string, IndexEntry]
  })
}

function listGuildContainers(
  _accessor: DiscordAccessor,
  _match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  return Promise.resolve<[string, IndexEntry][]>([
    ['channels', containerEntry('channels', own.id)],
    ['members', containerEntry('members', own.id)],
  ])
}

async function listChannelsDir(
  accessor: DiscordAccessor,
  _match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  const channels = await listChannels(accessor, own.id)
  return channels.map((c) => {
    const base = DiscordIndexEntry.channel(c)
    const lastMsgId = typeof c.last_message_id === 'string' ? c.last_message_id : ''
    const entry = lastMsgId !== '' ? base.copyWith({ remoteTime: lastMsgId }) : base
    return [entry.vfsName, entry] as [string, IndexEntry]
  })
}

async function listMembersDir(
  accessor: DiscordAccessor,
  _match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  const members = await listMembers(accessor, own.id)
  const entries: [string, IndexEntry][] = []
  for (const m of members) {
    const user = m.user
    if (user === undefined || user.id === '') continue
    // The listing already carries the whole member payload read() renders,
    // so the exact size is free here.
    const entry = DiscordIndexEntry.member(
      { id: user.id, name: user.username ?? '' },
      memberJsonBytes(m).byteLength,
    )
    entries.push([entry.vfsName, entry])
  }
  return entries
}

function listChannelDays(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  const lastMsgId = own.remoteTime
  const endDate = lastMsgId !== '' ? snowflakeToDate(lastMsgId) : todayUtc()
  const span = globSpan(match.pattern)
  const dates = accessor.timeRange.bounded
    ? accessor.timeRange.listingDays(snowflakeToDate(own.id), endDate, span)
    : dateRangeDescending(endDate, 30, span)
  const entries = dates.map(
    (d) => [d, DiscordIndexEntry.history(own.id, d)] as [string, IndexEntry],
  )
  return Promise.resolve({ entries, seeds: {}, partial: span !== null, window: true })
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
    if (isSoftError(e)) return { entries: [], seeds: {}, window: true }
    throw e
  }
  // The day's messages are already in hand, so chat.jsonl's exact rendered
  // size is free here; read() renders the same messages the same way.
  const chatEntry = new IndexEntry({
    id: `${channelId}:${dateStr}:chat`,
    name: 'chat.jsonl',
    resourceType: DiscordResourceType.CHAT_JSONL,
    vfsName: 'chat.jsonl',
    size: historyJsonlBytes(messages).byteLength,
  })
  const filesEntry = new IndexEntry({
    id: `${channelId}:${dateStr}:files`,
    name: 'files',
    resourceType: DiscordResourceType.FILES_DIR,
    vfsName: 'files',
    extra: { channel_id: channelId, date: dateStr },
  })
  const fileEntries: [string, IndexEntry][] = []
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
      // Tombstoned (deleted) and access-restricted attachment payloads
      // carry an id but no download URL and no byte size; read() ENOENTs
      // on them, so listing them would surface phantom files with unknown
      // sizes. Mirrors the slack guard.
      if (!att.id || !att.url || att.size === undefined) continue
      const blobName = fileBlobName(att)
      fileEntries.push([
        blobName,
        new IndexEntry({
          id: att.id,
          name: att.filename ?? '',
          resourceType: DiscordResourceType.FILE,
          vfsName: blobName,
          size: att.size,
          extra: {
            url: att.url,
            proxy_url: att.proxy_url ?? '',
            content_type: att.content_type ?? '',
            message_id: msg.id,
            author: (msg.author as { username?: string } | undefined)?.username ?? '',
            channel_id: channelId,
            date: dateStr,
          },
        }),
      ])
    }
  }
  return {
    entries: [
      ['chat.jsonl', chatEntry],
      ['files', filesEntry],
    ],
    seeds: { files: fileEntries },
  }
}

function listDay(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  channel: IndexEntry,
): Promise<Listed> {
  // The proof is the channel entry, not the day's own: any well-formed date
  // under a real channel fetches, including dates outside the bounded window
  // the channel listing mints.
  return dayListing(accessor, channel.id, match.slots.day ?? '')
}

export async function listFiles(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  // Normally served from the day lister's seed; reached only when the index
  // evicted the files listing while the day's entries survived.
  const fromExtra = typeof own.extra.channel_id === 'string' ? own.extra.channel_id : ''
  const channelId = fromExtra !== '' ? fromExtra : (own.id.split(':', 1)[0] ?? '')
  const listing = await dayListing(accessor, channelId, match.slots.day ?? '')
  // A soft-error day proves nothing about its attachments either.
  return { entries: [...(listing.seeds.files ?? [])], seeds: {}, window: listing.window === true }
}

export const readdir = makeReaddir<DiscordAccessor>(detectScope, {
  listers: { root: listRoot },
  entryListers: {
    guild: listGuildContainers,
    channels_dir: listChannelsDir,
    members_dir: listMembersDir,
    channel: listChannelDays,
    files: listFiles,
  },
  parentEntryListers: { day: listDay },
  guards: { day: guardDay, files: guardDay },
  patternKinds: { channel: hasGlobSpan },
  leafError: 'enotdir',
})
