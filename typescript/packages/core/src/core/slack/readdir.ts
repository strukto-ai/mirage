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
import type { SlackAccessor } from '../../accessor/slack.ts'
import { ContentType, DirListing, FileStat, FileType } from '../../types.ts'
import { epochToIso } from '../../utils/dates.ts'
import { contentTypeForMime } from '../../utils/filetype.ts'
import { cutListing, makeReaddir, type Listed } from '../hierarchy/readdir.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { jsonlBytes } from '../render/json.ts'
import { listChannels, listDms } from './channels.ts'
import { channelDirname, dmDirname, fileBlobName, userFilename } from './formatters.ts'
import { fetchMessagesForDay, type SlackMessage } from './history.ts'
import { cursorPages } from './paginate.ts'
import { detectScope } from './scope.ts'
import { listUsers, userJsonBytes } from './users.ts'
import { globSpan, hasGlobSpan } from '../../utils/glob_walk.ts'

export const VIRTUAL_ROOTS = ['channels', 'dms', 'users'] as const

const SOFT_HISTORY_ERRORS = [
  'not_in_channel',
  'channel_not_found',
  'missing_scope',
  'is_archived',
  'not_authed',
]

function isSoftHistoryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return SOFT_HISTORY_ERRORS.some((code) => msg.includes(code))
}

export async function latestMessageTs(
  accessor: SlackAccessor,
  channelId: string,
): Promise<number | null> {
  let messages: { ts?: string }[]
  try {
    const data = await accessor.transport.call('conversations.history', {
      channel: channelId,
      limit: '1',
    })
    messages = (data.messages as { ts?: string }[] | undefined) ?? []
  } catch (err) {
    if (isSoftHistoryError(err)) return null
    throw err
  }
  if (messages.length === 0) return null
  return Number.parseFloat(messages[0]?.ts ?? '0')
}

/**
 * Discover the history start when conversation metadata omits creation.
 *
 * Only history before the scope's end is paged: a message after it is out
 * of scope, and the first message overall precedes the end whenever
 * anything in scope exists at all.
 */
async function earliestMessageTs(
  accessor: SlackAccessor,
  channelId: string,
  latest: number,
): Promise<number> {
  const params: Record<string, string> = { channel: channelId, limit: '200' }
  if (accessor.timeRange.end !== null) params.latest = accessor.timeRange.end.toFixed(6)
  let first = latest
  for await (const page of cursorPages<{ ts: string }>(
    accessor.transport,
    'conversations.history',
    params,
    'messages',
  )) {
    for (const message of page) first = Math.min(first, Number.parseFloat(message.ts))
  }
  return first
}

/**
 * The channel's day directories, newest first.
 *
 * A day dir is real for any date the channel has existed for, so the bare
 * listing is a window: the last `maxDays` up to the newest message. A glob
 * names its own window instead, and then the cap does not apply, because the
 * span is already bounded by what was typed.
 */
export function dateRange(
  latestTs: number,
  created: number,
  maxDays = 90,
  span: readonly [string, string] | null = null,
): string[] {
  const endMs = Math.floor(latestTs * 1000)
  const startMs = Math.floor(created * 1000)
  const endDate = new Date(endMs)
  const startDate = new Date(startMs)
  let endUtc = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate())
  let startUtc = Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  )
  const dayMs = 86_400_000
  if (span !== null) {
    startUtc = Math.max(startUtc, Date.parse(`${span[0]}T00:00:00Z`))
    endUtc = Math.min(endUtc, Date.parse(`${span[1]}T00:00:00Z`) - dayMs)
  } else if ((endUtc - startUtc) / dayMs > maxDays) {
    startUtc = endUtc - (maxDays - 1) * dayMs
  }
  const dates: string[] = []
  for (let cursor = endUtc; cursor >= startUtc; cursor -= dayMs) {
    const d = new Date(cursor)
    const yyyy = d.getUTCFullYear().toString().padStart(4, '0')
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0')
    const dd = d.getUTCDate().toString().padStart(2, '0')
    dates.push(`${yyyy}-${mm}-${dd}`)
  }
  return dates
}

function slackModified(remoteTime: string | number | null | undefined): string | null {
  if (remoteTime === null || remoteTime === undefined || remoteTime === '' || remoteTime === 0) {
    return null
  }
  const ts = typeof remoteTime === 'number' ? remoteTime : Number.parseFloat(remoteTime)
  if (Number.isNaN(ts) || ts <= 0) return null
  return epochToIso(ts)
}

function conversation(
  dirname: string,
  convo: { id: string; created?: number | null },
  name: string,
): FileStat {
  const created = convo.created ?? 0
  return new FileStat({
    name: dirname,
    type: FileType.DIRECTORY,
    modified: slackModified(created),
    extra: { channel_id: convo.id, name, created },
  })
}

async function listChannelsRoot(
  accessor: SlackAccessor,
  match: ScopeMatch,
): Promise<Listed | null> {
  const channels = await listChannels(accessor, { stopAt: match.limit })
  return cutListing(
    channels.map((ch) => conversation(channelDirname(ch), ch, ch.name ?? '')),
    match.limit,
  )
}

async function listDmsRoot(accessor: SlackAccessor, _match: ScopeMatch): Promise<Listed | null> {
  const dms = await listDms(accessor)
  const users = await listUsers(accessor)
  const userMap: Record<string, string> = {}
  for (const u of users) userMap[u.id] = u.name ?? u.id
  return dms.map((dm) => {
    const uid = dm.user ?? ''
    return conversation(dmDirname(dm, userMap), dm, userMap[uid] ?? uid)
  })
}

async function listUsersRoot(accessor: SlackAccessor, match: ScopeMatch): Promise<Listed | null> {
  const users = await listUsers(accessor, { stopAt: match.limit })
  const rows = users.map(
    (u) =>
      new FileStat({
        name: userFilename(u),
        type: FileType.FILE,
        content: ContentType.JSON,
        size: userJsonBytes(u).byteLength,
        extra: { user_id: u.id },
      }),
  )
  return cutListing(rows, match.limit)
}

async function listChannelDays(
  accessor: SlackAccessor,
  match: ScopeMatch,
  own: FileStat,
): Promise<Listed> {
  const channelId = String(own.extra.channel_id)
  const created = Number(own.extra.created ?? 0) || 0
  const span = globSpan(match.pattern)
  const latestTs = await latestMessageTs(accessor, channelId)
  let dates: string[]
  if (latestTs !== null && accessor.timeRange.bounded) {
    const start = created || accessor.timeRange.start
    let first: string
    if (start !== null) first = new Date(start * 1000).toISOString().slice(0, 10)
    else if (span !== null) first = span[0]
    else {
      const earliest = await earliestMessageTs(accessor, channelId, latestTs)
      first = new Date(earliest * 1000).toISOString().slice(0, 10)
    }
    dates = accessor.timeRange
      .listingDays(first, new Date(latestTs * 1000).toISOString().slice(0, 10), span)
      .reverse()
  } else if (latestTs !== null && created > 0) {
    dates = dateRange(latestTs, created, 90, span)
  } else if (latestTs !== null) {
    dates = dateRange(latestTs, Math.floor(latestTs), 90, span)
  } else {
    dates = []
  }
  const rows = dates.map(
    (d) => new FileStat({ name: d, type: FileType.DIRECTORY, extra: { channel_id: channelId } }),
  )
  return new DirListing({ entries: rows, partial: span !== null, window: true })
}

/**
 * One history fetch, answering the day dir and its files subdir.
 *
 * A soft history error (not_in_channel, missing_scope, ...) seals an empty
 * day: the dir lists nothing, and read reproduces the API's own answer.
 */
async function dayListing(
  accessor: SlackAccessor,
  channelId: string,
  dateStr: string,
): Promise<DirListing> {
  let messages: SlackMessage[]
  try {
    messages = await fetchMessagesForDay(accessor, channelId, dateStr)
  } catch (err) {
    if (isSoftHistoryError(err)) return new DirListing({ entries: [], window: true })
    throw err
  }
  const blobs: FileStat[] = []
  for (const msg of messages) {
    const files = (msg.files as { id?: string }[] | undefined) ?? []
    for (const fmeta of files) {
      const meta = fmeta as {
        id?: string
        name?: string
        title?: string
        size?: number
        mimetype?: string
        filetype?: string
        url_private_download?: string
        timestamp?: number | string
      }
      // Tombstoned (deleted) and access-restricted file payloads carry an
      // id but no download URL and no byte size; read() ENOENTs on them, so
      // listing them would both surface phantom files and break the
      // sizesAlwaysKnown contract.
      if (meta.id === undefined || meta.id === '') continue
      if (meta.size === undefined || !meta.url_private_download) continue
      const mimetype = meta.mimetype ?? ''
      blobs.push(
        new FileStat({
          name: fileBlobName(meta),
          type: FileType.FILE,
          content: contentTypeForMime(mimetype),
          size: meta.size,
          modified: slackModified(meta.timestamp),
          extra: {
            file_id: meta.id,
            mimetype,
            url_private_download: meta.url_private_download ?? '',
            filetype: meta.filetype ?? '',
            ts: typeof msg.ts === 'string' ? msg.ts : '',
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

function listDay(accessor: SlackAccessor, match: ScopeMatch, own: FileStat): Promise<Listed> {
  // The day's row carries its channel: one the bounded window lists, or one
  // stat makes for any well-formed date under a real channel, so a date
  // outside the window fetches too.
  return dayListing(accessor, String(own.extra.channel_id), match.slots.day ?? '')
}

export async function listFiles(
  accessor: SlackAccessor,
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

export const readdir = makeReaddir<SlackAccessor>(detectScope, {
  listers: {
    channels_root: listChannelsRoot,
    dms_root: listDmsRoot,
    users_root: listUsersRoot,
  },
  entryListers: {
    channel: listChannelDays,
    day: listDay,
    files: listFiles,
  },
  staticRoot: VIRTUAL_ROOTS,
  guards: { day: guardDay, files: guardDay },
  patternKinds: { channel: hasGlobSpan },
})
