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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { MongoDBAccessor } from '../../accessor/mongodb.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { readdir } from './readdir.ts'
import { fnmatch } from '../../utils/fnmatch.ts'

const SCOPE_ERROR = 10000

export async function resolveGlob(
  accessor: MongoDBAccessor,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[]> {
  const result: PathSpec[] = []
  for (const p of paths) {
    if (p.resolved) {
      result.push(p)
    } else if (p.pattern !== null) {
      const entries = await readdir(accessor, p.dir, index)
      const pat = p.pattern
      const matched = entries
        .filter((e) => {
          const tail = e.split('/').pop() ?? ''
          return fnmatch(tail, pat)
        })
        .map(
          (e) =>
            new PathSpec({
              virtual: e,
              directory: p.directory,
              resourcePath: mountKey(e, mountPrefixOf(p.virtual, p.resourcePath)),
            }),
        )
      const truncated = matched.slice(0, SCOPE_ERROR)
      result.push(...truncated)
    } else {
      result.push(p)
    }
  }
  return result
}
