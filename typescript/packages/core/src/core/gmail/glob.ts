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

import { rekey } from '../../utils/key_prefix.ts'
import type { GmailAccessor } from '../../accessor/gmail.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { fnmatch } from '../../utils/fnmatch.ts'
import { PathSpec } from '../../types.ts'
import { SCOPE_ERROR } from '../github/constants.ts'
import { readdir } from './readdir.ts'
import { rstripSlash } from '../../utils/slash.ts'

export async function resolveGlob(
  accessor: GmailAccessor,
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
      const entries = await readdir(accessor, p, index)
      const matched: PathSpec[] = []
      for (const entry of entries) {
        const trimmed = rstripSlash(entry)
        const base = trimmed.split('/').pop() ?? trimmed
        if (!fnmatch(base, p.pattern)) continue
        matched.push(PathSpec.fromStrPath(trimmed, rekey(p.virtual, p.resourcePath, trimmed)))
      }
      const truncated = matched.length > SCOPE_ERROR ? matched.slice(0, SCOPE_ERROR) : matched
      result.push(...truncated)
    } else {
      result.push(p)
    }
  }
  return result
}
