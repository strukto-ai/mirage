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
import { IndexEntry } from '../../cache/index/config.ts'
import { makeReaddir, type DirListing, type Listed } from '../hierarchy/readdir.ts'
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

async function listChannelsRoot(
  accessor: SlackAccessor,
  _match: ScopeMatch,
): Promise<Listed | null> {
  const channels = await listChannels(accessor)
  return channels.map((ch) => {
    const dirname = channelDirname(ch)
    return [
      dirname,
      new IndexEntry({
        id: ch.id,
        name: ch.name ?? '',
        resourceType: 'slack/channel',
        vfsName: dirname,
        remoteTime: String(ch.created ?? 0),
      }),
    ] as [string, IndexEntry]
  })
}

async function listDmsRoot(accessor: SlackAccessor, _match: ScopeMatch): Promise<Listed | null> {
  const dms = await listDms(accessor)
  const users = await listUsers(accessor)
  const userMap: Record<string, string> = {}
  for (const u of users) userMap[u.id] = u.name ?? u.id
  return dms.map((dm) => {
    const dirname = dmDirname(dm, userMap)
    const uid = dm.user ?? ''
    return [
      dirname,
      new IndexEntry({
        id: dm.id,
        name: userMap[uid] ?? uid,
        resourceType: 'slack/dm',
        vfsName: dirname,
        remoteTime: String(dm.created ?? 0),
      }),
    ] as [string, IndexEntry]
  })
}

async function listUsersRoot(accessor: SlackAccessor, _match: ScopeMatch): Promise<Listed | null> {
  const users = await listUsers(accessor)
  return users.map((u) => {
    const filename = userFilename(u)
    return [
      filename,
      new IndexEntry({
        id: u.id,
        name: u.name ?? '',
        resourceType: 'slack/user',
        vfsName: filename,
        size: userJsonBytes(u).byteLength,
      }),
    ] as [string, IndexEntry]
  })
}

async function listChannelDays(
  accessor: SlackAccessor,
  match: ScopeMatch,
  own: IndexEntry,
): Promise<Listed> {
  const created = Number.parseInt(own.remoteTime !== '' ? own.remoteTime : '0', 10)
  const span = globSpan(match.pattern)
  const latestTs = await latestMessageTs(accessor, own.id)
  let dates: string[]
  if (latestTs !== null && accessor.timeRange.bounded) {
    const start = created || accessor.timeRange.start
    let first: string
    if (start !== null) first = new Date(start * 1000).toISOString().slice(0, 10)
    else if (span !== null) first = span[0]
    else {
      const earliest = await earliestMessageTs(accessor, own.id, latestTs)
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
  const entries = dates.map(
    (d) =>
      [
        d,
        new IndexEntry({
          id: `${own.id}:${d}`,
          name: d,
          resourceType: 'slack/date_dir',
          vfsName: d,
          extra: { channel_id: own.id },
        }),
      ] as [string, IndexEntry],
  )
  return { entries, seeds: {}, partial: span !== null, window: true }
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
    if (isSoftHistoryError(err)) return { entries: [], seeds: {}, window: true }
    throw err
  }
  const chatEntry = new IndexEntry({
    id: `${channelId}:${dateStr}:chat`,
    name: 'chat.jsonl',
    resourceType: 'slack/chat_jsonl',
    vfsName: 'chat.jsonl',
    size: jsonlBytes(messages).byteLength,
  })
  const filesEntry = new IndexEntry({
    id: `${channelId}:${dateStr}:files`,
    name: 'files',
    resourceType: 'slack/files_dir',
    vfsName: 'files',
    extra: { channel_id: channelId, date: dateStr },
  })
  const fileEntries: [string, IndexEntry][] = []
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
      const blob = fileBlobName(meta)
      fileEntries.push([
        blob,
        new IndexEntry({
          id: meta.id,
          name: meta.title ?? meta.name ?? '',
          resourceType: 'slack/file',
          vfsName: blob,
          size: meta.size,
          remoteTime: String(meta.timestamp ?? ''),
          extra: {
            mimetype: meta.mimetype ?? '',
            url_private_download: meta.url_private_download ?? '',
            filetype: meta.filetype ?? '',
            ts: typeof msg.ts === 'string' ? msg.ts : '',
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

function listDay(accessor: SlackAccessor, match: ScopeMatch, channel: IndexEntry): Promise<Listed> {
  // The proof is the channel entry, not the day's own: any well-formed date
  // under a real channel fetches, including dates outside the bounded window
  // the channel listing mints.
  return dayListing(accessor, channel.id, match.slots.day ?? '')
}

export async function listFiles(
  accessor: SlackAccessor,
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

export const readdir = makeReaddir<SlackAccessor>(detectScope, {
  listers: {
    channels_root: listChannelsRoot,
    dms_root: listDmsRoot,
    users_root: listUsersRoot,
  },
  entryListers: {
    channel: listChannelDays,
    files: listFiles,
  },
  parentEntryListers: { day: listDay },
  staticRoot: VIRTUAL_ROOTS,
  guards: { day: guardDay, files: guardDay },
  patternKinds: { channel: hasGlobSpan },
})
