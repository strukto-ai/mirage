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

import type { SlackAccessor } from '../../accessor/slack.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { epochToIso } from '../../utils/dates.ts'
import { enoent } from '../../utils/errors.ts'
import { contentTypeForMime } from '../../utils/filetype.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function slackModified(remoteTime: string): string | null {
  if (remoteTime === '') return null
  const ts = Number.parseFloat(remoteTime)
  if (Number.isNaN(ts) || ts <= 0) return null
  return epochToIso(ts)
}

function channelStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  const modified = slackModified(entry.remoteTime)
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    type: FileType.DIRECTORY,
    ...(modified !== null ? { modified } : {}),
    extra: { channel_id: entry.id },
  })
}

function userStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    type: FileType.FILE,
    content: ContentType.JSON,
    ...(entry.size !== null ? { size: entry.size } : {}),
    extra: { user_id: entry.id },
  })
}

function dirStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
}

function chatStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  // A denied or empty day lists no chat.jsonl, and the kit reports the
  // absent entry as ENOENT: slack does not fabricate a sizeless file for a
  // sealed day (discord deliberately does; see its override).
  return new FileStat({
    name: 'chat.jsonl',
    type: FileType.FILE,
    content: ContentType.TEXT,
    ...(entry.size !== null ? { size: entry.size } : {}),
  })
}

function fileBlobStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  const mimetype = typeof entry.extra.mimetype === 'string' ? entry.extra.mimetype : ''
  const modified = slackModified(entry.remoteTime)
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    type: FileType.FILE,
    content: contentTypeForMime(mimetype),
    size: entry.size ?? null,
    ...(modified !== null ? { modified } : {}),
    extra: { file_id: entry.id },
  })
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
  accessor: SlackAccessor,
  match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const entry = await resolveEntry(readdir, accessor, path, index)
  if (entry !== null) {
    return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
  }
  const virtual = path.virtual.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const channelSpec = new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, prefix),
  })
  if ((await resolveEntry(readdir, accessor, channelSpec, index)) === null) {
    throw enoent(path)
  }
  return new FileStat({ name: match.slots.day ?? '', type: FileType.DIRECTORY })
}

export const stat = makeStat<SlackAccessor>(detectScope, readdir, {
  entryStats: {
    channel: channelStat,
    user: userStat,
    messages: chatStat,
    files: dirStat,
    file_blob: fileBlobStat,
  },
  overrides: { day: statDay },
})
