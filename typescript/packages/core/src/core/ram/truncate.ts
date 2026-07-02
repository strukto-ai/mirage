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
import { norm, nowIso } from './utils.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'

export async function truncate(
  accessor: RAMAccessor,
  path: PathSpec,
  length: number,
): Promise<void> {
  const p = norm(path.mountPath)
  const existing = accessor.store.files.get(p) ?? new Uint8Array()
  const out = new Uint8Array(length)
  out.set(existing.subarray(0, Math.min(existing.byteLength, length)))
  accessor.store.files.set(p, out)
  accessor.store.modified.set(p, nowIso())
  await invalidateAfterWrite(path)
  return Promise.resolve()
}
