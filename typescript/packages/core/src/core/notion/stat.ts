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

import type { NotionAccessor } from '../../accessor/notion.ts'
import { enoent } from '../../errors/fs.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { pageSegmentName } from './normalize.ts'
import { resolveRow } from './resolve.ts'
import { detectScope } from './scope.ts'

async function rowStat(
  accessor: NotionAccessor,
  match: ScopeMatch,
  path: PathSpec,
  entry: FileStat | null,
  parent: FileStat | null,
): Promise<FileStat> {
  // No listing names a row: its data source lists it as a line of
  // rows.jsonl, so a row proves itself against the data source the mount
  // hands as its parent, once; the mount hands what it proved.
  if (entry !== null) return entry
  if (parent === null) throw enoent(path.virtual)
  const page = await resolveRow(accessor, match, path.virtual)
  const edited = typeof page.last_edited_time === 'string' ? page.last_edited_time : ''
  return new FileStat({
    name: pageSegmentName(page),
    type: FileType.DIRECTORY,
    modified: edited !== '' ? edited : null,
    extra: { page_id: typeof page.id === 'string' ? page.id : '' },
  })
}

function rowJsonStat(
  _accessor: NotionAccessor,
  _match: ScopeMatch,
  path: PathSpec,
  _entry: FileStat | null,
  parent: FileStat | null,
): Promise<FileStat> {
  if (parent === null) return Promise.reject(enoent(path.virtual))
  return Promise.resolve(
    new FileStat({ name: 'page.json', type: FileType.FILE, content: ContentType.JSON }),
  )
}

export const stat = makeStat(detectScope, {
  overrides: { row: rowStat, row_json: rowJsonStat },
})
