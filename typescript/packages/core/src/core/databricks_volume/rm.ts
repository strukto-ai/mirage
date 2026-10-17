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

import { deleteFile, deleteDirectory, listDirectoryContents } from './client.ts'
import { ensurePathSpec } from './_helpers.ts'
import { isNotFound } from './errors.ts'
import { backendPath, virtualPath } from './path.ts'
import { stat } from './stat.ts'
import { unlink } from './unlink.ts'
import { enoent } from '../../errors/fs.ts'

async function removeTreeRecurse(
  accessor: DatabricksVolumeAccessor,
  remoteDir: string,
  removed: string[],
): Promise<void> {
  for (const entry of await listDirectoryContents(accessor, remoteDir)) {
    if (entry.isDirectory) {
      await removeTreeRecurse(accessor, entry.path, removed)
    } else {
      await deleteFile(accessor, entry.path)
      removed.push(entry.path)
    }
  }
  await deleteDirectory(accessor, remoteDir)
  removed.push(remoteDir)
}

export async function rmRecursive(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
): Promise<string[]> {
  const p = ensurePathSpec(path)
  const fileStat = await stat(accessor, p)
  if (fileStat.type !== FileType.DIRECTORY) {
    await unlink(accessor, p)
    return [p.mountPath]
  }
  const remoteRoot = backendPath(accessor.config, p)
  const removed: string[] = []
  try {
    await removeTreeRecurse(accessor, remoteRoot, removed)
  } catch (exc) {
    if (isNotFound(exc)) throw enoent(p.virtual)
    throw exc
  }
  return removed.map((backend) => virtualPath(accessor.config, backend, ''))
}
