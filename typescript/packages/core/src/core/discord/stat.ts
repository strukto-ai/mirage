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
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { contentTypeForMime } from '../../utils/filetype.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat, makeStat } from '../hierarchy/stat.ts'
import { readdir, snowflakeToIso } from './readdir.ts'
import { detectScope } from './scope.ts'

function dirStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
}

function guildStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    type: FileType.DIRECTORY,
    extra: { guild_id: entry.id },
  })
}

function channelStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  const modified = snowflakeToIso(entry.remoteTime)
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    type: FileType.DIRECTORY,
    ...(modified !== null ? { modified } : {}),
    extra: { channel_id: entry.id },
  })
}

function fileBlobStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  const mimetype = typeof entry.extra.content_type === 'string' ? entry.extra.content_type : ''
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    ...(entry.size !== null ? { size: entry.size } : {}),
    type: FileType.FILE,
    content: contentTypeForMime(mimetype),
    extra: { content_type: mimetype, attachment_id: entry.id },
  })
}

/**
 * Raise ENOENT unless the path's channel ancestor exists. `up` is how many
 * trailing segments to drop to reach the channel (1 for a day dir, 2 for its
 * children).
 */
async function channelProven(
  accessor: DiscordAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  up: number,
): Promise<void> {
  let virtual = path.virtual.replace(/\/+$/, '')
  for (let i = 0; i < up; i++) virtual = virtual.split('/').slice(0, -1).join('/')
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const spec = new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, prefix),
  })
  if ((await resolveEntry(readdir, accessor, spec, index)) === null) {
    throw enoent(path)
  }
}

/**
 * Stat a day directory, which resolves beyond the listed window.
 *
 * The channel listing synthesizes a bounded window of recent days, but the
 * history API answers a range query for any date, so a well-formed day under
 * a channel that exists is a directory whether or not the window lists it. A
 * bogus channel chain is ENOENT.
 */
async function statDay(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry !== null) {
    return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
  }
  await channelProven(accessor, path, index, 1)
  return new FileStat({ name: match.slots.day ?? '', type: FileType.DIRECTORY })
}

/**
 * Stat chat.jsonl, which survives a sealed day.
 *
 * A day whose history could not be listed (403/404/429) seals an empty date
 * dir; the file still stats, with the size left unknown.
 */
async function statChat(
  accessor: DiscordAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry !== null) {
    return new FileStat({
      name: 'chat.jsonl',
      type: FileType.FILE,
      content: ContentType.TEXT,
      ...(entry.size !== null ? { size: entry.size } : {}),
    })
  }
  await channelProven(accessor, path, index, 2)
  return new FileStat({ name: 'chat.jsonl', type: FileType.FILE, content: ContentType.TEXT })
}

export const stat = makeStat<DiscordAccessor>(detectScope, readdir, {
  entryStats: {
    guild: guildStat,
    channels_dir: dirStat,
    members_dir: dirStat,
    channel: channelStat,
    member: entryStat('user_id', ContentType.JSON),
    files: dirStat,
    file_blob: fileBlobStat,
  },
  overrides: {
    day: statDay,
    messages: statChat,
  },
})
