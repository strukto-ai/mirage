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

import { invalidateAfterUnlink } from '@struktoai/mirage-core'
import { FileType, type IndexCacheStore, type PathSpec, record } from '@struktoai/mirage-core'
import type { HfAccessor } from '../../accessor/hf.ts'
import { invalidateAncestors } from '@struktoai/mirage-core'
import { stat } from './stat.ts'
import { hfKey, isNotFound, rawPathOf } from './util.ts'
import { enoent } from '@struktoai/mirage-core'

export async function unlink(
  accessor: HfAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  const fileStat = await stat(accessor, path, index)
  const rawPath = rawPathOf(path)
  if (fileStat.type === FileType.DIRECTORY) {
    const e = new Error(`EISDIR: ${rawPath}`) as Error & { code: string }
    e.code = 'EISDIR'
    throw e
  }
  const key = hfKey(rawPath)
  const op = await accessor.operator()
  const startMs = performance.now()
  try {
    await op.delete(key)
  } catch (err) {
    if (isNotFound(err)) throw enoent(path)
    throw err
  }
  record('unlink', path.virtual, accessor.resourceName, 0, startMs)
  await invalidateAfterUnlink(path)
  await invalidateAncestors(path)
}
