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
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { guessType } from '../../utils/filetype.ts'
import { rstripSlash, stripSlash } from '../../utils/slash.ts'
import { dbxFetch } from './_client.ts'
import { isNotFound, notFoundError } from './errors.ts'
import { backendPath } from './path.ts'

function nameFromBackendPath(remotePath: string): string {
  const stripped = stripSlash(remotePath)
  return stripped.split('/').pop() ?? stripped
}

export function modifiedFromHeader(value: string | null): string | null {
  if (value === null || value === '') return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString()
}

async function directoryStatOrRaise(
  accessor: DatabricksVolumeAccessor,
  remotePath: string,
  path: PathSpec,
): Promise<FileStat> {
  try {
    await dbxFetch(accessor, 'HEAD', 'directories', remotePath)
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(path.original)
    throw exc
  }
  return new FileStat({ name: nameFromBackendPath(remotePath), type: FileType.DIRECTORY })
}

export async function stat(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const stripped = stripSlash(path.stripPrefix)
  if (stripped === '') {
    return new FileStat({ name: '/', type: FileType.DIRECTORY })
  }
  // Fast path: the index cache populated by readdir() carries size, mtime, and
  // type for every listed entry, so stat returns without a network round-trip.
  // Mirrors Python's mirage/core/databricks_volume/stat.py.
  if (index !== undefined) {
    const prefix = path.prefix
    const virtualKey = prefix !== '' ? `${rstripSlash(prefix)}/${stripped}` : `/${stripped}`
    const lookup = await index.get(virtualKey)
    if (lookup.entry !== undefined && lookup.entry !== null) {
      const entry = lookup.entry
      if (entry.resourceType === 'folder') {
        return new FileStat({ name: entry.name, type: FileType.DIRECTORY })
      }
      return new FileStat({
        name: entry.name,
        size: entry.size ?? null,
        modified: entry.remoteTime !== '' ? entry.remoteTime : null,
        type: guessType(entry.name),
      })
    }
    // Parent was already listed and didn't include this path — it doesn't exist.
    const parent = virtualKey.replace(/\/[^/]*$/, '') || '/'
    const parentListing = await index.listDir(parent)
    if (parentListing.entries !== undefined && parentListing.entries !== null) {
      throw notFoundError(path.original)
    }
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
  return new FileStat({ name, size, modified, type: guessType(name) })
}
