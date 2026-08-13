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
import { norm, nowIso } from './utils.ts'
import { invalidateAfterWrite } from '../../cache/context.ts'
import { checkDestParents } from './dest.ts'

export async function create(accessor: RAMAccessor, path: PathSpec): Promise<void> {
  // Not a delegation to writeBytes: that recorded the op as 'write',
  // so a guest creating a file and one writing one were the same row
  // in the ledger.
  const start = performance.now()
  const p = norm(path.mountPath)
  checkDestParents(accessor, path, p)
  accessor.store.files.set(p, new Uint8Array())
  accessor.store.modified.set(p, nowIso())
  record('create', p, ResourceName.RAM, 0, start)
  await invalidateAfterWrite(path)
  return Promise.resolve()
}
