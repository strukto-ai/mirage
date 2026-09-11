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

import type { IndexEntry } from '@struktoai/mirage-core/cache/index/config'
import { makeStat } from '@struktoai/mirage-core/core/hierarchy/stat'
import type { ScopeMatch } from '@struktoai/mirage-core/core/hierarchy/scope'
import type { PathSpec } from '@struktoai/mirage-core/types'
import { ContentType, FileStat, FileType } from '@struktoai/mirage-core/types'
import { contentTypeForPath } from '@struktoai/mirage-core/utils/filetype'
import type { EmailAccessor } from '../../accessor/email.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function dirStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({ name: entry.vfsName, type: FileType.DIRECTORY })
}

function messageStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
    extra: { uid: entry.id },
  })
}

function attachmentDirStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    extra: { uid: entry.id },
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

export const stat = makeStat<EmailAccessor>(detectScope, readdir, {
  entryStats: {
    folder: dirStat,
    day: dirStat,
    message: messageStat,
    attachment_dir: attachmentDirStat,
    attachment: attachmentStat,
  },
})
