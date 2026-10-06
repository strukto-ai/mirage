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

import { activeCacheManager } from '../../cache/context.ts'
import { entryOrWarm } from '../../cache/index/warm.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, PathSpec } from '../../types.ts'
import { absentOn404, listFolderItems, type BoxItem } from './api.ts'
import { SHA1 } from './constants.ts'
import { tokenOf } from './fingerprint.ts'
import { enotdir, enoent } from '../../errors/fs.ts'
import { rstripSlash } from '../../utils/slash.ts'

export function resourceTypeFor(item: BoxItem): string {
  if (item.type === 'folder') return 'box/folder'
  if (item.type === 'web_link') return 'box/weblink'
  return 'box/file'
}

export async function readdir(
  accessor: BoxAccessor,
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

  let folderId: string
  if (key === '') {
    folderId = accessor.rootFolderId
  } else {
    if (index === undefined) {
      throw enoent(path.virtual)
    }
    const probed = activeCacheManager()?.probedStat(path)
    if (probed != null && probed.type !== FileType.DIRECTORY) throw enotdir(path.virtual)
    const parentVirtual = rstripSlash(virtualKey).replace(/\/[^/]+$/, '') || '/'
    const parentPath = PathSpec.fromStrPath(parentVirtual, mountKey(parentVirtual, prefix))
    const entry = await entryOrWarm(index, virtualKey, () => readdir(accessor, parentPath, index))
    if (entry === null) throw enoent(path.virtual)
    if (entry.resourceType !== 'box/folder') throw enotdir(path.virtual)
    folderId = entry.id
  }

  const items = await absentOn404(path.virtual, () =>
    listFolderItems(accessor.tokenManager, folderId),
  )
  const entries: { name: string; entry: IndexEntry; isDir: boolean }[] = []
  for (const it of items) {
    if (it.type === 'web_link') {
      // Weblinks are bookmarks: no content endpoint, no size. Hide them
      // from listings instead of serving an unreadable entry.
      continue
    }
    const isDir = it.type === 'folder'
    const filename = it.name
    const sha1 = tokenOf(it[SHA1])
    const entry = new IndexEntry({
      id: it.id,
      name: filename,
      resourceType: resourceTypeFor(it),
      remoteTime: it.modified_at ?? '',
      vfsName: filename,
      size: isDir ? null : typeof it.size === 'number' ? it.size : null,
      extra: sha1 === null ? {} : { [SHA1]: sha1 },
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
