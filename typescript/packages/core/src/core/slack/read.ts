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

import { chunks } from '../../io/cooperative.ts'
import type { Handed } from '../../vfs/types.ts'
import { dayChannelId, followedDay, guardDay, readDays } from '../time_range.ts'
import type { SlackAccessor } from '../../accessor/slack.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { makeRead, makeReadRange, perKind } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import {
  fetchMessagesForDay,
  getHistoryJsonl,
  streamMessagesForDay,
  type SlackMessage,
} from './history.ts'
import { getUserProfile, userJsonBytes } from './users.ts'
import { detectScope } from './scope.ts'

async function readChat(
  accessor: SlackAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
  parent: FileStat | null,
): Promise<Uint8Array> {
  await guardDay(accessor, match, path.virtual)
  const channelId = dayChannelId(path, entry, parent)
  return getHistoryJsonl(accessor, channelId, match.slots.day ?? '')
}

async function readUser(
  accessor: SlackAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<Uint8Array> {
  if (entry === null) throw enoent(path)
  const user = await getUserProfile(accessor, String(entry.extra.user_id))
  return userJsonBytes(user)
}

async function blobUrl(
  accessor: SlackAccessor,
  path: PathSpec,
  entry: FileStat | null,
): Promise<string> {
  await guardDay(accessor, detectScope(path), path.virtual)
  if (entry === null) throw enoent(path)
  const url =
    typeof entry.extra.url_private_download === 'string' ? entry.extra.url_private_download : ''
  if (url === '') throw enoent(path)
  return url
}

async function downloadBlob(
  accessor: SlackAccessor,
  url: string,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  if (accessor.transport.downloadFile === undefined) {
    throw new Error('slack transport does not support file downloads')
  }
  return accessor.transport.downloadFile(url, offset, size)
}

async function readBlob(
  accessor: SlackAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
): Promise<Uint8Array> {
  return downloadBlob(accessor, await blobUrl(accessor, path, entry), 0, null)
}

async function readBlobRange(
  accessor: SlackAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
  _parent: FileStat | null,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  return downloadBlob(accessor, await blobUrl(accessor, path, entry), offset, size)
}

export const read = makeRead<SlackAccessor>(detectScope, {
  messages: readChat,
  user: readUser,
  file_blob: readBlob,
})

// Only an uploaded file has a remote range to ask for. A channel's history
// and a user profile are rendered here into JSON, so their bytes do not
// exist until we make them and the window can only be taken afterwards.
export const readRange = makeReadRange<SlackAccessor>(detectScope, read, {
  file_blob: readBlobRange,
})

/** Stream attachments; preserve the rendered order of JSON records. */
export async function* readStream(
  accessor: SlackAccessor,
  path: PathSpec,
  entry: FileStat | null = null,
  parent: FileStat | null = null,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array, void> {
  if (detectScope(path).kind === 'file_blob') {
    const url = await blobUrl(accessor, path, entry)
    const source =
      accessor.transport.downloadFileStream === undefined
        ? await downloadBlob(accessor, url, 0, null)
        : accessor.transport.downloadFileStream(url, signal)
    yield* chunks(source, signal)
  } else {
    yield* chunks(await read(accessor, path, entry, parent), signal)
  }
}

/**
 * A channel or DM day's last `n` messages, then each one posted to it, asked for every
 * `interval` seconds while the day lasts (`followedDay`). Mirrors Python's
 * `_follow_chat`.
 */
async function followChat(
  accessor: SlackAccessor,
  match: ScopeMatch,
  path: PathSpec,
  n: number,
  interval: number,
  entry: FileStat | null = null,
  parent: FileStat | null = null,
): Promise<AsyncIterable<Uint8Array>> {
  await guardDay(accessor, match, path.virtual)
  const channelId = dayChannelId(path, entry, parent)
  const day = match.slots.day ?? ''
  const [, end] = accessor.timeRange.dayBounds(day)
  return followedDay<SlackMessage>(
    await fetchMessagesForDay(accessor, channelId, day),
    n,
    end,
    interval,
    (last) => fetchMessagesForDay(accessor, channelId, day, last === null ? undefined : last.ts),
  )
}

export const follow = perKind(detectScope, { messages: followChat })

/** A run of a channel's days, fetched as one. Mirrors Python's `_fetch_run`. */
function runPages(
  accessor: SlackAccessor,
  channelId: string,
  first: string,
  last: string,
): AsyncIterable<SlackMessage[]> {
  return streamMessagesForDay(accessor, channelId, first, { lastDay: last })
}

/** A message's place among its day's lines. Mirrors Python's `_sort_key`. */
function sortKey(message: SlackMessage): number {
  return Number.parseFloat(message.ts)
}

/** Whether a message was posted in a day's bounds. Mirrors Python's `_posted_within`. */
function postedWithin(message: SlackMessage, start: number, end: number): boolean {
  return Number(message.ts) >= start && Number(message.ts) < end
}

/**
 * Several chat.jsonl files, one history walk per run of a channel's
 * consecutive days (`readDays`). Mirrors Python's `read_many`.
 */
export function readMany(
  accessor: SlackAccessor,
  paths: readonly PathSpec[],
  limit: number,
  handed: readonly Handed[] = [],
): Promise<Map<string, Uint8Array>> {
  return readDays(
    accessor.timeRange,
    paths,
    handed,
    detectScope,
    (channelId, first, last) => runPages(accessor, channelId, first, last),
    sortKey,
    postedWithin,
    limit,
  )
}
