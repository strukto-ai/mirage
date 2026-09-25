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

import type { Mem0Accessor } from '../../accessor/mem0.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import type { ScopeMatch } from '../hierarchy/scope.ts'
import { makeStat } from '../hierarchy/stat.ts'
import { jsonBytes } from '../render/json.ts'
import { listedMemory, readdir } from './readdir.ts'
import { detectScope } from './scope.ts'

function fileStat(memory: Record<string, unknown>): FileStat {
  return new FileStat({
    name: `${String(memory.id)}.json`,
    type: FileType.FILE,
    content: ContentType.JSON,
    size: jsonBytes(memory).length,
    modified:
      typeof memory.updated_at === 'string'
        ? memory.updated_at
        : typeof memory.created_at === 'string'
          ? memory.created_at
          : null,
    id: String(memory.id),
    extra: { created_at: memory.created_at, updated_at: memory.updated_at },
  })
}

async function memoryStat(
  accessor: Mem0Accessor,
  _match: ScopeMatch,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  return fileStat(await listedMemory(accessor, path, index))
}

export const stat = makeStat(detectScope, readdir, {
  overrides: { memory: memoryStat },
})
