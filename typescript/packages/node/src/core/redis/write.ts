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

import { ResourceName, invalidateAfterWrite, record, type PathSpec } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm, nowIso, parent } from './utils.ts'

export async function writeBytes(
  accessor: RedisAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const start = performance.now()
  const p = norm(path.mountPath)
  const par = parent(p)
  const store = accessor.store
  if (par !== '/' && !(await store.hasDir(par))) {
    throw new Error(`parent directory does not exist: ${par}`)
  }
  await store.setFile(p, data)
  await store.setModified(p, nowIso())
  record('write', p, ResourceName.REDIS, data.byteLength, start)
  await invalidateAfterWrite(p)
}
