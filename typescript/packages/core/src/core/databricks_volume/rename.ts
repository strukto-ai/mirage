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

import { invalidateAfterUnlink, invalidateAfterWrite } from '../../cache/context.ts'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { ensurePathSpec } from './_helpers.ts'
import { copy } from './copy.ts'
import { backendPath } from './path.ts'
import { rmRecursive } from './rm.ts'
import { stat } from './stat.ts'
import { unlink } from './unlink.ts'

export async function rename(
  accessor: DatabricksVolumeAccessor,
  src: PathSpec,
  dst: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  // Non-atomic: the Databricks Files API has no native rename, so this is
  // implemented as copy + delete and can leave partial state on failure.
  const s = ensurePathSpec(src)
  const d = ensurePathSpec(dst)
  const srcStat = await stat(accessor, s, index)
  const remoteSrc = backendPath(accessor.config, s)
  const remoteDst = backendPath(accessor.config, d)
  if (remoteSrc === remoteDst) {
    // rename(2) onto the same path is a no-op; copy + unlink here would
    // upload the file onto itself then delete it, destroying the data.
    // Guard runs after stat so a missing source still raises.
    return
  }
  if (srcStat.type === FileType.DIRECTORY) {
    if (remoteDst.startsWith(remoteSrc + '/')) {
      // Moving a directory into its own subtree would run away in the
      // recursive copy and then rmRecursive would delete the original.
      // Refuse before either side effect.
      throw new Error(`cannot move '${s.virtual}' to a subdirectory of itself, '${d.virtual}'`)
    }
    await copy(accessor, s, d, index, true)
    await rmRecursive(accessor, s, index)
  } else {
    await copy(accessor, s, d, index)
    await unlink(accessor, s, index)
  }
  await invalidateAfterWrite(d)
  await invalidateAfterUnlink(s)
}
