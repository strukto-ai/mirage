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

import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { expandPattern, isWordShaped } from '../../utils/glob_walk.ts'
import { SCOPE_ERROR } from '../s3/constants.ts'
import type { NotionTransport } from './_client.ts'
import { readdir } from './readdir.ts'

export interface NotionGlobAccessor {
  readonly transport: NotionTransport
}

export async function resolveNotionGlob(
  accessor: NotionGlobAccessor,
  paths: readonly PathSpec[],
  index?: IndexCacheStore,
): Promise<PathSpec[]> {
  const result: PathSpec[] = []
  for (const p of paths) {
    if (p.resolved) {
      result.push(p)
      continue
    }
    if (p.pattern !== null && p.pattern !== '') {
      const matched = await expandPattern(readdir, accessor, p, index)
      if (matched.length === 0 && isWordShaped(p)) {
        // bash nullglob off: an unmatched glob word stays literal
        result.push(
          new PathSpec({
            virtual: p.virtual,
            directory: p.directory,
            resourcePath: p.resourcePath,
            pattern: null,
            resolved: true,
            rawPath: p.rawPath,
          }),
        )
        continue
      }
      const truncated = matched.length > SCOPE_ERROR ? matched.slice(0, SCOPE_ERROR) : matched
      result.push(...truncated)
    } else {
      result.push(p)
    }
  }
  return result
}
