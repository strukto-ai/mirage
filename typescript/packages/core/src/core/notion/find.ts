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

import { RAMIndexCacheStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { FindOptions } from '../../vfs/types.ts'
import type { PathSpec } from '../../types.ts'
import type { NotionAccessor } from '../../accessor/notion.ts'
import { walkFind } from '../generic/find.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

export async function find(
  accessor: NotionAccessor,
  path: PathSpec,
  options: FindOptions = {},
  index?: IndexCacheStore,
): Promise<string[]> {
  const walkIndex = index ?? new RAMIndexCacheStore()
  return walkFind(
    path,
    {
      readdir: (spec) => readdir(accessor, spec, walkIndex),
      stat: (spec) => stat(accessor, spec, walkIndex),
    },
    options,
    walkIndex,
  )
}
