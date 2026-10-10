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
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { entryStat, makeStat } from '../hierarchy/stat.ts'
import { dayStat } from '../time_range.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function labelStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    extra: { label_id: entry.id },
  })
}

function messageStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
    extra: {
      message_id: entry.id,
      ...('size_estimate' in entry.extra ? { size_estimate: entry.extra.size_estimate } : {}),
    },
  })
}

function attachmentDirStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    extra: { message_id: entry.id },
  })
}

export const stat = makeStat<GmailAccessor>(detectScope, readdir, {
  entryStats: {
    label: labelStat,
    message: messageStat,
    attachment_dir: attachmentDirStat,
    attachment: entryStat('attachment_id'),
  },
  overrides: { day: dayStat(readdir) },
})
