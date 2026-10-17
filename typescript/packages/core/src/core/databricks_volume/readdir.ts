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

import { toIsoZ } from '../../utils/dates.ts'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { getMetadata, getDirectoryMetadata, listDirectoryContents } from './client.ts'
import type { DirectoryEntry } from './types.ts'
import { isNotFound } from './errors.ts'
import { backendPath } from './path.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { listingError } from '../../errors/fs.ts'

async function head(
  accessor: DatabricksVolumeAccessor,
  endpoint: 'files' | 'directories',
  key: string,
): Promise<boolean> {
  try {
    await (endpoint === 'files' ? getMetadata : getDirectoryMetadata)(
      accessor,
      backendPath(accessor.config, key),
    )
  } catch (exc) {
    if (isNotFound(exc)) return false
    throw exc
  }
  return true
}

/**
 * A folder's rows, as the Files API lists them. Mirrors Python's `readdir`.
 *
 * Throws:
 *   FileNotFoundError: nothing is at the path.
 *   NotADirectoryError: the path, or a folder above it, is a file.
 */
export async function readdir(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
): Promise<FileStat[]> {
  const listPath = path.pattern !== null ? path.dir : path
  const remotePath = backendPath(accessor.config, listPath)
  let entries: DirectoryEntry[]
  try {
    entries = await listDirectoryContents(accessor, remotePath)
  } catch (exc) {
    // The Files API answers 404 for a missing path and for a path under a
    // file alike, so the errno comes from walking the ancestors: one
    // metadata request per component, on this failure path only.
    if (isNotFound(exc)) {
      throw await listingError(
        listPath.virtual,
        listPath.mountPath,
        (p) => head(accessor, 'files', p),
        (p) => head(accessor, 'directories', p),
      )
    }
    throw exc
  }
  const rows: FileStat[] = []
  for (const entry of [...entries].sort((a, b) => compareCodePoints(a.path, b.path))) {
    const name = rstripSlash(entry.path).split('/').pop() ?? entry.path
    if (entry.isDirectory) {
      rows.push(new FileStat({ name, type: FileType.DIRECTORY }))
      continue
    }
    let size = entry.fileSize
    size ??= (await getMetadata(accessor, entry.path)).contentLength

    rows.push(
      new FileStat({
        name,
        size,
        modified: entry.lastModified === null ? null : toIsoZ(new Date(entry.lastModified)),
        type: FileType.FILE,
        content: contentTypeForPath(name),
      }),
    )
  }
  return rows
}
