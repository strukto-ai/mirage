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

import type { LanceDBAccessor } from '../../accessor/lancedb.ts'
import { ContentType } from '../../types.ts'
import type { resolveLanceDBConfig } from '../../vfs/lancedb/config.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import { Codec, PATH_SAFE } from '../hierarchy/codec.ts'
import { makeDetectScope, type DetectFn, type Scope } from '../hierarchy/scope.ts'
import { blobLeaf, rowScopes } from '../vector/scope.ts'
import type { Leaf } from '../vector/types.ts'

const CARD = new Codec({ suffix: '.md' })

/**
 * The mount's scope table, shaped by its config.
 *
 * A pinned `table` removes the leading table segment, and `blobColumn` adds a
 * second leaf suffix beside the `.md` card. A group slot decodes through
 * `PATH_SAFE`, so a value holding `/` keeps its own directory and the WHERE
 * clause holds the exact value.
 */
export function scopesFor(config: ReturnType<typeof resolveLanceDBConfig>): Scope[] {
  const leaves: Leaf[] = [['row_card', CARD, ContentType.TEXT]]
  if (config.blobColumn !== null) leaves.push(blobLeaf(config.blobExt))
  return rowScopes(
    config.table !== null,
    config.groupBy.map(() => PATH_SAFE),
    leaves,
  )
}

function buildDetect(accessor: LanceDBAccessor): DetectFn {
  return makeDetectScope(scopesFor(accessor.config))
}

export const detectFor = perAccessor(buildDetect)
