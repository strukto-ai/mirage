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

import { invalidateAfterWrite, type PathSpec } from '@struktoai/mirage-core'
import type { RedisAccessor } from '../../accessor/redis.ts'
import { norm, nowIso } from './utils.ts'

export async function create(accessor: RedisAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.mountPath)
  const store = accessor.store
  await store.setFile(p, new Uint8Array(0))
  await store.setModified(p, nowIso())
  await invalidateAfterWrite(path)
}
