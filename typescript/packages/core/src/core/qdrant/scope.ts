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

import type { QdrantAccessor } from '../../accessor/qdrant.ts'
import { ContentType } from '../../types.ts'
import type { resolveQdrantConfig } from '../../vfs/qdrant/config.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import { Codec, JSON_NAME, PATH_SAFE, RAW } from '../hierarchy/codec.ts'
import { makeDetectScope, type DetectFn, type Scope } from '../hierarchy/scope.ts'
import { blobLeaf, rowScopes } from '../vector/scope.ts'
import type { Leaf } from '../vector/types.ts'

const TXT = new Codec({ suffix: '.txt' })

/**
 * The mount's scope table, shaped by its config.
 *
 * A pinned `collection` removes the leading collection segment, and
 * `textField` / `blobField` each add a leaf suffix beside the `.json` row. A
 * group slot decodes through `PATH_SAFE`, so its filter holds the exact value
 * the directory was rendered from; a `basenameFields` slot stays `RAW`
 * because its rendering drops the value's parents and the lister resolves it
 * against the payload instead.
 */
export function scopesFor(config: ReturnType<typeof resolveQdrantConfig>): Scope[] {
  const leaves: Leaf[] = [['row_json', JSON_NAME, ContentType.TEXT]]
  if (config.textField !== null) leaves.push(['row_text', TXT, ContentType.TEXT])
  if (config.blobField !== null) leaves.push(blobLeaf(config.blobExt))
  const groups = config.groupBy.map((column) =>
    config.basenameFields.includes(column) ? RAW : PATH_SAFE,
  )
  return rowScopes(config.collection !== null, groups, leaves)
}

function buildDetect(accessor: QdrantAccessor): DetectFn {
  return makeDetectScope(scopesFor(accessor.config))
}

export const detectFor = perAccessor(buildDetect)
