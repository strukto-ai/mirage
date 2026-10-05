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

import { dayChannelId, guardDay } from '../time_range.ts'
import type { SlackAccessor } from '../../accessor/slack.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { makeRead, makeReadRange } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { getHistoryJsonl } from './history.ts'
import { readdir } from './readdir.ts'
import { getUserProfile, userJsonBytes } from './users.ts'
import { detectScope } from './scope.ts'

async function readChat(
  accessor: SlackAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  await guardDay(accessor, match, path.virtual)
  const channelId = await dayChannelId(readdir, accessor, path, index)
  return getHistoryJsonl(accessor, channelId, match.slots.day ?? '')
}

async function readUser(
  accessor: SlackAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry === null) throw enoent(path)
  const user = await getUserProfile(accessor, entry.id)
  return userJsonBytes(user)
}

async function blobUrl(
  accessor: SlackAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<string> {
  await guardDay(accessor, detectScope(path), path.virtual)
  const entry = await resolveEntry(readdir, accessor, path, index)
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
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  return downloadBlob(accessor, await blobUrl(accessor, path, index), 0, null)
}

async function readBlobRange(
  accessor: SlackAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  return downloadBlob(accessor, await blobUrl(accessor, path, index), offset, size)
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
