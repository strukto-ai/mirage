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

import { type PathSpec, invalidateAfterWrite } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm, nowIso, parent } from './utils.ts'
import { stripSlash } from '@struktoai/mirage-core'

export async function mkdir(
  accessor: RedisAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const p = norm(path.mountPath)
  const store = accessor.store
  if (parents) {
    const parts = stripSlash(p).split('/')
    let current = ''
    const now = nowIso()
    for (const part of parts) {
      current += `/${part}`
      await store.addDir(current)
      const mod = await store.getModified(current)
      if (mod === null) {
        await store.setModified(current, now)
      }
    }
    return
  }
  const par = parent(p)
  if (par !== '/' && !(await store.hasDir(par))) {
    throw new Error(`parent directory does not exist: ${par}`)
  }
  await store.addDir(p)
  await store.setModified(p, nowIso())
  await invalidateAfterWrite(p)
}
