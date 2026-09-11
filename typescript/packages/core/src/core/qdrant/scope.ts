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
import type { QdrantConfigResolved } from '../../resource/qdrant/config.ts'
import { ContentType } from '../../types.ts'
import { contentTypeForExtension } from '../../utils/filetype.ts'
import { perAccessor } from '../hierarchy/bind.ts'
import { Codec, JSON_NAME } from '../hierarchy/codec.ts'
import { Scope, Slot, makeDetectScope, type DetectFn, type ScopeMatch } from '../hierarchy/scope.ts'

const TXT = new Codec({ suffix: '.txt' })

/**
 * The mount's scope table, shaped by its config.
 *
 * The tree is a function of the mount config, not of the backend: a pinned
 * `collection` removes the leading collection segment, every `groupBy` column
 * adds one directory level, and `textField` / `blobField` each add a leaf
 * suffix beside the `.json` row. Group slots are named positionally (`g0`,
 * `g1`, ...) so a column named `table` cannot collide with the collection
 * slot; `filtersOf` maps them back to column names. Every partial depth
 * shares the one `group` kind, and its lister derives the depth from the
 * slots, so the lister table stays static while the scope table varies per
 * mount.
 */
export function scopesFor(config: QdrantConfigResolved): Scope[] {
  const prefix: Slot[] = config.collection !== null ? [] : [new Slot('table')]
  const groups = config.groupBy.map((_, i) => new Slot(`g${String(i)}`))
  const scopes: Scope[] = []
  for (let depth = 0; depth <= groups.length; depth++) {
    if (depth === 0 && prefix.length === 0) continue
    scopes.push(new Scope({ kind: 'group', segments: [...prefix, ...groups.slice(0, depth)] }))
  }
  const full = [...prefix, ...groups]
  scopes.push(
    new Scope({
      kind: 'row_json',
      segments: [...full, new Slot('row_id', JSON_NAME)],
      leaf: true,
      filetype: ContentType.TEXT,
    }),
  )
  if (config.textField !== null) {
    scopes.push(
      new Scope({
        kind: 'row_text',
        segments: [...full, new Slot('row_id', TXT)],
        leaf: true,
        filetype: ContentType.TEXT,
      }),
    )
  }
  if (config.blobField !== null) {
    const blob = new Codec({ suffix: `.${config.blobExt}` })
    scopes.push(
      new Scope({
        kind: 'row_blob',
        segments: [...full, new Slot('row_id', blob)],
        leaf: true,
        filetype: contentTypeForExtension(config.blobExt),
      }),
    )
  }
  return scopes
}

function buildDetect(accessor: QdrantAccessor): DetectFn {
  return makeDetectScope(scopesFor(accessor.config))
}

export const detectFor = perAccessor(buildDetect)

/** The collection a match addresses: pinned, or the path's first slot. */
export function tableOf(config: QdrantConfigResolved, match: ScopeMatch): string {
  if (config.collection !== null) return config.collection
  return match.slots.table ?? ''
}

/** The match's group filters, keyed back to column names. */
export function filtersOf(config: QdrantConfigResolved, match: ScopeMatch): Record<string, string> {
  const filters: Record<string, string> = {}
  for (let i = 0; i < config.groupBy.length; i++) {
    const value = match.slots[`g${String(i)}`]
    const column = config.groupBy[i]
    if (value === undefined || column === undefined) break
    filters[column] = value
  }
  return filters
}
