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

import { invalidateAfterUnlink } from '../../cache/context.ts'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { record } from '../../observe/context.ts'
import { FileType, ResourceName, type PathSpec } from '../../types.ts'
import { dbxFetch } from './_client.ts'
import { ensurePathSpec } from './_helpers.ts'
import { isADirectoryError, isNotFound, notFoundError } from './errors.ts'
import { backendPath } from './path.ts'
import { stat } from './stat.ts'

export async function unlink(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<void> {
  const p = ensurePathSpec(path)
  const fileStat = await stat(accessor, p, index)
  if (fileStat.type === FileType.DIRECTORY) {
    throw isADirectoryError(p.virtual)
  }
  const remotePath = backendPath(accessor.config, p)
  const startMs = performance.now()
  try {
    await dbxFetch(accessor, 'DELETE', 'files', remotePath)
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(p.virtual)
    throw exc
  }
  record('unlink', p.virtual, ResourceName.DATABRICKS_VOLUME, 0, startMs)
  await invalidateAfterUnlink(p)
}
