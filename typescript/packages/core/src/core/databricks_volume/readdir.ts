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
import { dbxFetch } from './_client.ts'
import { isNotFound, notFoundError } from './errors.ts'
import { backendPath, virtualPath } from './path.ts'

export interface DbxDirectoryEntry {
  path: string
  is_directory?: boolean
  file_size?: number
  last_modified?: number
  name?: string
}

interface DbxDirectoryPage {
  contents?: DbxDirectoryEntry[]
  next_page_token?: string
}

export async function listDirectoryContents(
  accessor: DatabricksVolumeAccessor,
  remotePath: string,
): Promise<DbxDirectoryEntry[]> {
  const entries: DbxDirectoryEntry[] = []
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
  let entries: DbxDirectoryEntry[]
  try {
    entries = await listDirectoryContents(accessor, remotePath)
  } catch (exc) {
    if (isNotFound(exc)) throw notFoundError(listPath.virtual)
    throw exc
  }
  const pairs = entries
    .map(
      (entry) =>
        [
          virtualPath(accessor.config, entry.path, mountPrefixOf(path.virtual, path.resourcePath)),
          entry,
        ] as [string, DbxDirectoryEntry],
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const names: string[] = []
  const indexEntries: [string, IndexEntry][] = []
  for (const [fullPath, entry] of pairs) {
    const isDir = entry.is_directory === true
    names.push(fullPath)
    const name = rstripSlash(fullPath).split('/').pop() ?? fullPath
    const remoteTime =
      typeof entry.last_modified === 'number' ? new Date(entry.last_modified).toISOString() : ''
    indexEntries.push([
      name,
      new IndexEntry({
        id: fullPath,
        name,
        resourceType: isDir ? 'folder' : 'file',
        size: !isDir && typeof entry.file_size === 'number' ? entry.file_size : null,
        remoteTime,
      }),
    ])
  }
  if (index !== undefined) {
    await index.setDir(virtualKey, indexEntries)
  }
  return names
}
