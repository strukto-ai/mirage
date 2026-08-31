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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { DatabricksVolumeAccessor } from '../../accessor/databricks_volume.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { dbxFetch, type DbxEndpoint } from './client.ts'
import { isNotFound } from './errors.ts'
import { backendPath, virtualPath } from './path.ts'
import type { DatabricksEntry } from './types.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { listingError } from '../../utils/errors.ts'

interface DbxDirectoryPage {
  contents?: DatabricksEntry[]
  next_page_token?: string
}

export async function listDirectoryContents(
  accessor: DatabricksVolumeAccessor,
  remotePath: string,
): Promise<DatabricksEntry[]> {
  const entries: DatabricksEntry[] = []
  let pageToken: string | undefined
  do {
    const query: Record<string, string> = pageToken !== undefined ? { page_token: pageToken } : {}
    const r = await dbxFetch(accessor, 'GET', 'directories', remotePath, { query })
    const page = (await r.json()) as DbxDirectoryPage
    entries.push(...(page.contents ?? []))
    pageToken = page.next_page_token !== '' ? page.next_page_token : undefined
  } while (pageToken !== undefined)
  return entries
}

async function head(
  accessor: DatabricksVolumeAccessor,
  endpoint: DbxEndpoint,
  key: string,
): Promise<boolean> {
  try {
    await dbxFetch(accessor, 'HEAD', endpoint, backendPath(accessor.config, key))
  } catch (exc) {
    if (isNotFound(exc)) return false
    throw exc
  }
  return true
}

export async function readdir(
  accessor: DatabricksVolumeAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const listPath = path.pattern !== null ? path.dir : path
  const virtualKey = rstripSlash(listPath.virtual) || '/'
  if (index !== undefined) {
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
  }
  const remotePath = backendPath(accessor.config, listPath)
  let entries: DatabricksEntry[]
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
  const pairs = entries
    .map(
      (entry) =>
        [
          virtualPath(accessor.config, entry.path, mountPrefixOf(path.virtual, path.resourcePath)),
          entry,
        ] as [string, DatabricksEntry],
    )
    .sort((a, b) => compareCodePoints(a[0], b[0]))
  const names: string[] = []
  const indexEntries: [string, IndexEntry][] = []
  for (const [fullPath, entry] of pairs) {
    const isDir = entry.is_directory === true
    names.push(fullPath)
    const name = rstripSlash(fullPath).split('/').pop() ?? fullPath
    const remoteTime =
      typeof entry.last_modified === 'number' ? new Date(entry.last_modified).toISOString() : ''
    let size = !isDir && typeof entry.file_size === 'number' ? entry.file_size : null
    if (!isDir && size === null) {
      // DirectoryEntry normally carries file_size; when the lister omits
      // it, one HEAD per affected file fills the gap so the index never
      // caches an unknown size.
      const r = await dbxFetch(accessor, 'HEAD', 'files', entry.path)
      const lengthHeader = r.headers.get('content-length')
      size = lengthHeader !== null && lengthHeader !== '' ? Number(lengthHeader) : null
    }
    indexEntries.push([
      name,
      new IndexEntry({
        id: fullPath,
        name,
        resourceType: isDir ? 'folder' : 'file',
        size,
        remoteTime,
      }),
    ])
  }
  if (index !== undefined) {
    await index.setDir(virtualKey, indexEntries)
  }
  return names
}
