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

import { rstripSlash, type PathSpec } from '@struktoai/mirage-core'
import type { GridFSAccessor } from '../../../accessor/gridfs.ts'
import { gridfsKey, iterLatest, rawPathOf, stripKeyPrefix } from '../_client.ts'
import { duQuery } from './walk.ts'

/**
 * Return `[path, size]` pairs for every file under the prefix plus the
 * total. Mirrors Python's `du.entries`.
 */
export async function entries(
  accessor: GridFSAccessor,
  path: PathSpec,
): Promise<[[string, number][], number]> {
  const raw = rawPathOf(path)
  const stem = rstripSlash(gridfsKey(raw, accessor.config))
  const entries: [string, number][] = []
  let total = 0
  for await (const doc of iterLatest(accessor, duQuery(stem))) {
    const entry = '/' + stripKeyPrefix(doc.filename, accessor.config)
    entries.push([entry, doc.length])
    total += doc.length
  }
  return [entries, total]
}
