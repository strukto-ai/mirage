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

function pageStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    modified: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: { page_id: entry.id },
  })
}

function pageJsonStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
  })
}

function databaseStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    modified: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: { database_id: entry.id },
  })
}

function databaseJsonStat(match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
    extra: { database_id: match.slots.database_id ?? '' },
  })
}

function dataSourceStat(_match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.DIRECTORY,
    modified: entry.remoteTime !== '' ? entry.remoteTime : null,
    extra: { data_source_id: entry.id },
  })
}

function dataSourceJsonStat(match: ScopeMatch, _path: PathSpec, entry: IndexEntry): FileStat {
  return new FileStat({
    name: entry.vfsName,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: entry.size,
    extra: { data_source_id: match.slots.data_source_id ?? '' },
  })
}

export const stat = makeStat(detectScope, readdir, {
  entryStats: {
    page: pageStat,
    page_json: pageJsonStat,
    database: databaseStat,
    database_json: databaseJsonStat,
    data_source: dataSourceStat,
    data_source_json: dataSourceJsonStat,
  },
})
