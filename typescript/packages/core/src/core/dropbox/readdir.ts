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
import type { DropboxAccessor } from '../../accessor/dropbox.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { listingError } from '../../utils/errors.ts'
import { DropboxApiError } from './client.ts'
import { getMetadata, listFolder, type DropboxEntry } from './api.ts'
import { stripSlash } from '../../utils/slash.ts'

function resourceTypeFor(entry: DropboxEntry): string {
  if (entry['.tag'] === 'folder') return 'dropbox/folder'
  return 'dropbox/file'
}

function dropboxPathFromKey(root: string, key: string): string {
  if (key === '') return root
  return `${root}/${key}`
}

async function metadataOrNull(
  accessor: DropboxAccessor,
  key: string,
): Promise<DropboxEntry | null> {
  try {
    return await getMetadata(
      accessor.tokenManager,
      dropboxPathFromKey(accessor.rootPath, stripSlash(key)),
    )
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 409) return null
    throw err
  }
}

async function isFile(accessor: DropboxAccessor, key: string): Promise<boolean> {
  const entry = await metadataOrNull(accessor, key)
  return entry !== null && entry['.tag'] !== 'folder'
}

async function isDir(accessor: DropboxAccessor, key: string): Promise<boolean> {
  const entry = await metadataOrNull(accessor, key)
  return entry !== null && entry['.tag'] === 'folder'
}

export async function readdir(
  accessor: DropboxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  const key = (path.pattern !== null ? path.dir : path).vfsPath
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'

  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }

  const dropboxPath = dropboxPathFromKey(accessor.rootPath, key)
  let files: DropboxEntry[]
  try {
    files = await listFolder(accessor.tokenManager, dropboxPath)
  } catch (err) {
    // list_folder 409s on a missing path and on a file operand alike
    // (path/not_found, path/not_folder), and the subtag cannot tell ENOENT
    // from ENOTDIR either: a path under a file is not_found, where
    // opendir(2) reports Not a directory. So walk the ancestors and let the
    // walk pick the errno, at one request per component on this failure
    // path only.
    if (err instanceof DropboxApiError && err.status === 409) {
      throw await listingError(
        path.virtual,
        key,
        (p) => isFile(accessor, p),
        (p) => isDir(accessor, p),
      )
    }
    throw err
  }

  const entries: { name: string; entry: IndexEntry; isDir: boolean }[] = []
  for (const f of files) {
    const isDir = f['.tag'] === 'folder'
    const filename = f.name
    const modified = f.server_modified ?? f.client_modified ?? ''
    const size = typeof f.size === 'number' ? f.size : null
    const entry = new IndexEntry({
      id: f.id ?? f.path_display ?? filename,
      name: filename,
      resourceType: resourceTypeFor(f),
      remoteTime: modified,
      vfsName: filename,
      size: !isDir ? size : null,
    })
    entries.push({ name: filename, entry, isDir })
  }

  if (index !== undefined) {
    await index.setDir(
      virtualKey,
      entries.map((e) => [e.name, e.entry] as [string, IndexEntry]),
    )
  }
  const pathPrefix = key !== '' ? `/${key}/` : '/'
  const out: string[] = []
  for (const e of entries) {
    if (e.isDir) out.push(`${prefix}${pathPrefix}${e.name}/`)
    else out.push(`${prefix}${pathPrefix}${e.name}`)
  }
  return out
}
