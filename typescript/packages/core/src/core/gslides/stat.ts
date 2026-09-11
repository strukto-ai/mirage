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

import type { IndexEntry } from '../../cache/index/config.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function fileStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName !== '' ? entry.vfsName : entry.name,
    type: FileType.FILE,
    content: ContentType.JSON,
    modified: entry.remoteTime,
    size: entry.size,
    extra: {
      doc_id: entry.id,
      doc_name: entry.name,
      ...entry.extra,
    },
  })
}

export const stat = makeStat(detectScope, readdir, { entryStats: { file: fileStat } })
