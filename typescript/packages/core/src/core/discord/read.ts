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
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import { makeRead, makeReadRange } from '../hierarchy/read.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { downloadFile } from './files.ts'
import { getHistoryJsonl } from './history.ts'
import { listMembers } from './members.ts'
import { readdir } from './readdir.ts'
import { memberJsonBytes } from './render.ts'
import { detectScope } from './scope.ts'

async function ancestorEntry(
  accessor: DiscordAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  up: number,
): Promise<IndexEntry | null> {
  let virtual = path.virtual.replace(/\/+$/, '')
  for (let i = 0; i < up; i++) virtual = virtual.split('/').slice(0, -1).join('/')
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const spec = new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: mountKey(virtual, prefix),
  })
  return resolveEntry(readdir, accessor, spec, index)
}

/**
 * Render one day's history; the channel id comes from the listing.
 *
 * The typed `name__id` dirname is only trusted once the listing proves it,
 * so a fabricated channel id is ENOENT rather than a raw API error.
 */
async function readChat(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  let channelId: string
  if (entry !== null) {
    channelId = entry.id.split(':', 1)[0] ?? ''
  } else {
    // A sealed day lists nothing but the file still reads through the
    // channel, reproducing the API's own answer for the fetch.
    const channel = await ancestorEntry(accessor, path, index, 2)
    if (channel === null) throw enoent(path)
    channelId = channel.id
  }
  return getHistoryJsonl(accessor, channelId, match.slots.day ?? '')
}

async function readMember(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry === null) throw enoent(path)
  const members = await listMembers(accessor, match.slots.guild_id ?? '')
  for (const m of members) {
    if (m.user?.id === entry.id) return memberJsonBytes(m)
  }
  throw enoent(path)
}

async function blobUrl(
  accessor: DiscordAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
): Promise<string> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry === null) throw enoent(path)
  const extra = entry.extra
  const direct = typeof extra.url === 'string' ? extra.url : ''
  const proxy = typeof extra.proxy_url === 'string' ? extra.proxy_url : ''
  const url = direct !== '' ? direct : proxy
  if (url === '') throw enoent(path)
  return url
}

async function readBlob(
  accessor: DiscordAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  return downloadFile(await blobUrl(accessor, path, index), 0, null)
}

async function readBlobRange(
  accessor: DiscordAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  offset: number,
  size: number | null,
): Promise<Uint8Array> {
  return downloadFile(await blobUrl(accessor, path, index), offset, size)
}

export const read = makeRead<DiscordAccessor>(detectScope, {
  messages: readChat,
  member: readMember,
  file_blob: readBlob,
})

// Only an attachment has a remote range to ask for. A channel's history and
// a member profile are rendered here into JSON, so their bytes do not exist
// until we make them and the window can only be taken afterwards.
export const readRange = makeReadRange<DiscordAccessor>(detectScope, read, {
  file_blob: readBlobRange,
})
