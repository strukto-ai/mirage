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

import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { norm, nowIso, parent } from './utils.ts'
import { stripSlash } from '../../utils/slash.ts'
import { invalidateAfterWrite, invalidateAncestors } from '../../cache/context.ts'

export async function mkdir(accessor: RAMAccessor, path: PathSpec, parents = false): Promise<void> {
  const p = norm(path.mountPath)
  if (parents) {
    const parts = stripSlash(p).split('/').filter(Boolean)
    let current = ''
    const now = nowIso()
    for (const part of parts) {
      current += `/${part}`
      accessor.store.dirs.add(current)
      if (!accessor.store.modified.has(current)) {
        accessor.store.modified.set(current, now)
      }
    }
    await invalidateAfterWrite(path)
    await invalidateAncestors(path)
    return Promise.resolve()
  }
  const par = parent(p)
  if (par !== '/' && !accessor.store.dirs.has(par)) {
    throw new Error(`parent directory does not exist: ${par}`)
  }
  accessor.store.dirs.add(p)
  accessor.store.modified.set(p, nowIso())
  await invalidateAfterWrite(path)
  return Promise.resolve()
}
