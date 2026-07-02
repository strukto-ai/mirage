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

import type { PathSpec } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm } from './utils.ts'
import { invalidateAfterUnlink, rstripSlash } from '@struktoai/mirage-core'

export async function rmdir(accessor: RedisAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.mountPath)
  const store = accessor.store
  if (!(await store.hasDir(p))) {
    throw new Error(`not a directory: ${p}`)
  }
  const prefix = rstripSlash(p) + '/'
  const files = await store.listFiles()
  const dirs = await store.listDirs()
  const candidates = [...files, ...dirs]
  for (const k of candidates) {
    if (k !== p && k.startsWith(prefix)) {
      throw new Error(`directory not empty: ${p}`)
    }
  }
  await store.removeDir(p)
  await invalidateAfterUnlink(path)
}
