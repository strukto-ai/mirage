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
import { record, startOp } from '../../observe/context.ts'
import { FileType, VFSName, type PathSpec } from '../../types.ts'
import { deleteFile } from './client.ts'
import { isNotFound } from './errors.ts'
import { backendPath } from './path.ts'
import { stat } from './stat.ts'
import { eisdir, enoent } from '../../errors/fs.ts'

export async function unlink(accessor: DatabricksVolumeAccessor, path: PathSpec): Promise<void> {
  const fileStat = await stat(accessor, path)
  if (fileStat.type === FileType.DIRECTORY) {
    throw eisdir(path.virtual)
  }
  const remotePath = backendPath(accessor.config, path)
  const timer = startOp()
  try {
    await deleteFile(accessor, remotePath)
  } catch (exc) {
    if (isNotFound(exc)) throw enoent(path.virtual)
    throw exc
  }
  record('unlink', path.virtual, VFSName.DATABRICKS_VOLUME, 0, timer)
}
