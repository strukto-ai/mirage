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

import { record } from '../../observe/context.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import { ResourceName, type PathSpec } from '../../types.ts'
import { norm, nowIso, parent } from './utils.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'

export async function writeBytes(
  accessor: RAMAccessor,
  path: PathSpec,
  data: Uint8Array,
): Promise<void> {
  const start = performance.now()
  const p = norm(path.mountPath)
  const par = parent(p)
  if (par !== '/' && !accessor.store.dirs.has(par)) {
    throw new Error(`parent directory does not exist: ${par}`)
  }
  accessor.store.files.set(p, data)
  accessor.store.modified.set(p, nowIso())
  record('write', p, ResourceName.RAM, data.byteLength, start)
  await invalidateAfterWrite(path)
  return Promise.resolve()
}
