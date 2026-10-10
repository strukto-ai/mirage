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

import { dayStat, guardDay } from '../time_range.ts'
import type { DiscordAccessor } from '../../accessor/discord.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { enoent } from '../../errors/fs.ts'
import { contentTypeForMime } from '../../utils/filetype.ts'
import { ancestorEntry, resolveEntry } from '../hierarchy/probe.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat, makeStat } from '../hierarchy/stat.ts'
import { readdir } from './readdir.ts'
import { snowflakeToIso } from './entry.ts'
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
 * Stat chat.jsonl, which survives a sealed day.
 *
 * A day whose history could not be listed (403/404/429) seals an empty date
 * dir; the file still stats, with the size left unknown.
 */
async function statChat(
  accessor: DiscordAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  await guardDay(accessor, match, path.virtual)
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry !== null) {
    return new FileStat({
      name: 'chat.jsonl',
      type: FileType.FILE,
      content: ContentType.TEXT,
      ...(entry.size !== null ? { size: entry.size } : {}),
    })
  }
  if ((await ancestorEntry(readdir, accessor, path, index, 2)) === null) throw enoent(path)
  return new FileStat({ name: 'chat.jsonl', type: FileType.FILE, content: ContentType.TEXT })
}

export const stat = makeStat<DiscordAccessor>(detectScope, readdir, {
  guards: { messages: guardDay, files: guardDay, file_blob: guardDay },
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
    day: dayStat(readdir, guardDay),
    messages: statChat,
  },
})
