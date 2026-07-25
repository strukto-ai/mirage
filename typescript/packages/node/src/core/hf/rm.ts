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

import { invalidateAfterUnlink, record, stripSlash, type PathSpec } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../accessor/hf.ts'
import { invalidateAncestors } from '@struktoai/mirage-core'
import { rawPathOf } from './util.ts'

export async function rmR(accessor: HfAccessor, path: PathSpec): Promise<void> {
  const stripped = stripSlash(rawPathOf(path))
  const scanPath = stripped !== '' ? `${stripped}/` : '/'
  const op = await accessor.operator()
  const startMs = performance.now()
  const entries = await op.list(scanPath, { recursive: true })
  for (const entry of entries) {
    const key = entry.path()
    if (key.endsWith('/')) continue
    await op.delete(key)
  }
  record('rm_r', path.virtual, accessor.resourceName, 0, startMs)
  await invalidateAfterUnlink(path)
  await invalidateAncestors(path)
}
