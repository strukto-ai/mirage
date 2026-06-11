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

import { invalidateAfterWrite } from '../../cache/context.ts'
import type { RAMAccessor } from '../../accessor/ram.ts'
import type { PathSpec } from '../../types.ts'
import { norm } from '../../util/path.ts'
import { nowIso } from '../../util/time.ts'
import { stripSlash } from '../../util/slash.ts'

export async function mkdirP(accessor: RAMAccessor, path: PathSpec): Promise<void> {
  const p = norm(path.stripPrefix)
  const parts = stripSlash(p)
    .split('/')
    .filter((s) => s !== '')
  const now = nowIso()
  let current = ''
  for (const part of parts) {
    current += '/' + part
    accessor.store.dirs.add(current)
    if (!accessor.store.modified.has(current)) accessor.store.modified.set(current, now)
  }
  await invalidateAfterWrite(path)
}
