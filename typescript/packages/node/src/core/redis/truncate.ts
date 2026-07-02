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
import { norm, nowIso } from './utils.ts'

export async function truncate(
  accessor: RedisAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const p = norm(path.mountPath)
  const store = accessor.store
  const existing = await store.getFile(p)
  const data = existing ?? new Uint8Array(0)
  const out = new Uint8Array(length)
  const copyLen = Math.min(data.byteLength, length)
  out.set(data.subarray(0, copyLen), 0)
  await store.setFile(p, out)
  await store.setModified(p, nowIso())
  await invalidateAfterWrite(p)
}
