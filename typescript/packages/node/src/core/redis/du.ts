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
import { rstripSlash } from '@struktoai/mirage-core'

export async function du(accessor: RedisAccessor, path: PathSpec): Promise<number> {
  const p = norm(path.mountPath)
  const store = accessor.store
  const prefix = rstripSlash(p) + '/'
  let total = 0
  for (const key of await store.listFiles()) {
    if (key === p || key.startsWith(prefix)) {
      total += await store.fileLen(key)
    }
  }
  return total
}

export async function duAll(
  accessor: RedisAccessor,
  path: PathSpec,
): Promise<{ entries: [string, number][]; total: number }> {
  const p = norm(path.mountPath)
  const store = accessor.store
  const prefix = rstripSlash(p) + '/'
  const entries: [string, number][] = []
  let total = 0
  for (const key of await store.listFiles()) {
    if (key === p || key.startsWith(prefix)) {
      const size = await store.fileLen(key)
      entries.push([key, size])
      total += size
    }
  }
  return { entries, total }
}
