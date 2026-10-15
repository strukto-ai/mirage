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
import { stripSlash } from '../../utils/slash.ts'
import { dbxFetch } from './client.ts'
import { isNotFound } from './errors.ts'
import { backendPath } from './path.ts'
import { enoent } from '../../errors/fs.ts'

function nameFromBackendPath(remotePath: string): string {
  const stripped = stripSlash(remotePath)
  return stripped.split('/').pop() ?? stripped
}

function modifiedFromHeader(value: string | null): string | null {
  if (value === null || value === '') return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return toIsoZ(parsed)
}

async function directoryStatOrRaise(
  accessor: DatabricksVolumeAccessor,
  remotePath: string,
  path: PathSpec,
): Promise<FileStat> {
  try {
    await dbxFetch(accessor, 'HEAD', 'directories', remotePath)
  } catch (exc) {
    if (isNotFound(exc)) throw enoent(path.virtual)
    throw exc
  }
  return new FileStat({ name: nameFromBackendPath(remotePath), type: FileType.DIRECTORY })
}

export async function stat(accessor: DatabricksVolumeAccessor, path: PathSpec): Promise<FileStat> {
  const stripped = stripSlash(path.mountPath)
  if (stripped === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }
  const remotePath = backendPath(accessor.config, path)
  let r: Response
  try {
    r = await dbxFetch(accessor, 'HEAD', 'files', remotePath)
  } catch (exc) {
    if (isNotFound(exc)) {
      return directoryStatOrRaise(accessor, remotePath, path)
    }
    throw exc
  }
  const name = nameFromBackendPath(remotePath)
  const lengthHeader = r.headers.get('content-length')
  const size = lengthHeader !== null && lengthHeader !== '' ? Number(lengthHeader) : null
  const modified = modifiedFromHeader(r.headers.get('last-modified'))
  return new FileStat({
    name,
    size,
    modified,
    type: FileType.FILE,
    content: contentTypeForPath(name),
  })
}
