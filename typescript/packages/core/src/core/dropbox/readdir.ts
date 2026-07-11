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
import { listFolder, type DropboxEntry } from './api.ts'

function resourceTypeFor(entry: DropboxEntry): string {
  if (entry['.tag'] === 'folder') return 'dropbox/folder'
  return 'dropbox/file'
}

function dropboxPathFromKey(key: string): string {
  if (key === '') return ''
  return `/${key}`
}

export async function readdir(
  accessor: DropboxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const key = (path.pattern !== null ? path.dir : path).resourcePath
  const virtualKey = key !== '' ? `${prefix}/${key}` : prefix !== '' ? prefix : '/'

  if (index !== undefined) {
    const cached = await index.listDir(virtualKey)
    if (cached.entries !== undefined && cached.entries !== null) return cached.entries
  }

  const dropboxPath = dropboxPathFromKey(key)
  const files = await listFolder(accessor.tokenManager, dropboxPath)

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
      size: !isDir && size !== null && size > 0 ? size : null,
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
