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
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { dbxFetch } from './_client.ts'
import { ensurePathSpec, parentPath } from './_helpers.ts'
import { alreadyExistsError, isNotFound, notADirectoryError, notFoundError } from './errors.ts'
import { exists } from './exists.ts'
import { backendPath } from './path.ts'
import { stat } from './stat.ts'

async function createDirectory(
  accessor: DatabricksVolumeAccessor,
  remotePath: string,
  virtualTarget: string,
): Promise<void> {
  try {
    await dbxFetch(accessor, 'PUT', 'directories', remotePath)
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(virtualTarget)
    throw exc
  }
}

export async function mkdir(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  parents = false,
): Promise<void> {
  const p = ensurePathSpec(path)
  const remotePath = backendPath(accessor.config, p)
  if (parents) {
    await createDirectory(accessor, remotePath, p.virtual)
    return
  }
  if (await exists(accessor, p)) {
    throw alreadyExistsError(p.virtual)
  }
  const parentStat = await stat(accessor, parentPath(p), index)
  if (parentStat.type !== FileType.DIRECTORY) {
    throw notADirectoryError(p.virtual)
  }
  await createDirectory(accessor, remotePath, p.virtual)
  await invalidateAfterWrite(p)
}
