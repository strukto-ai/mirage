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

import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { createDirectory } from './client.ts'
import { parentPath } from './_helpers.ts'
import { isNotFound } from './errors.ts'
import { backendPath } from './path.ts'
import { stat } from './stat.ts'
import { enoent, enotdir } from '../../errors/fs.ts'

export async function mkdir(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  parents = false,
): Promise<void> {
  const remotePath = backendPath(accessor.config, path)
  if (!parents) {
    let parentStat
    try {
      parentStat = await stat(accessor, parentPath(path))
    } catch (exc) {
      if ((exc as { code?: string }).code === 'ENOENT') throw enoent(path.virtual)
      throw exc
    }
    if (parentStat.type !== FileType.DIRECTORY) {
      throw enotdir(path.virtual)
    }
  }
  try {
    await createDirectory(accessor, remotePath)
  } catch (exc) {
    if (isNotFound(exc)) throw enoent(path.virtual)
    throw exc
  }
}
