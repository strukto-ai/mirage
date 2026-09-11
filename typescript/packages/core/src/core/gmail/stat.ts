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

import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, PathSpec } from '../../types.ts'
import { enoent } from '../../utils/errors.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { resolveEntry } from '../hierarchy/probe.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function labelStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    extra: { label_id: entry.id },
  })
}

/**
 * Stat a day directory, which resolves beyond the listed window.
 *
 * The label listing groups a bounded number of recent messages into day dirs,
 * but the date query answers for any well-formed day, so a day under a label
 * that exists is a directory whether or not the recent window lists it. A
 * bogus label is ENOENT.
 */
async function statDay(
  accessor: GmailAccessor,
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
  const labelSpec = new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, prefix),
  })
  if ((await resolveEntry(readdir, accessor, labelSpec, index)) === null) {
    throw enoent(path)
  }
  return new FileStat({ name: match.slots.day ?? '', type: FileType.DIRECTORY })
}

function messageStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
    extra: { message_id: entry.id, ...entry.extra },
  })
}

function attachmentDirStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    extra: { message_id: entry.id },
  })
}

function attachmentStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: contentTypeForPath(entry.vfsName),
    size: entry.size,
    extra: { attachment_id: entry.id },
  })
}

export const stat = makeStat<GmailAccessor>(detectScope, readdir, {
  entryStats: {
    label: labelStat,
    message: messageStat,
    attachment_dir: attachmentDirStat,
    attachment: attachmentStat,
  },
  overrides: { day: statDay },
})
