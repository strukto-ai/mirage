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

import type { BoxAccessor } from '../../accessor/box.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { stripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { enotdir, enoent } from '../../errors/fs.ts'
import { absentOn404, listFolderItems, type BoxItem } from './api.ts'
import { SHA1 } from './constants.ts'
import { tokenOf } from './fingerprint.ts'

export function resourceTypeFor(item: BoxItem): string {
  if (item.type === 'folder') return 'box/folder'
  if (item.type === 'web_link') return 'box/weblink'
  return 'box/file'
}

/**
 * The stat of one Box item, as a listing, `GET /files/{id}` or an upload's
 * reply returns it. `extra` carries what the functions handed the stat act
 * on: the item id, and for a file the sha1 a read checks and the etag a
 * conditional write sends. Mirrors Python's `stat_from_item`.
 */
export function statFromItem(item: BoxItem): FileStat {
  const vfsName = item.name
  const rt = resourceTypeFor(item)
  if (rt === 'box/folder') {
    return new FileStat({
      name: vfsName,
      type: FileType.DIRECTORY,
      modified: item.modified_at ?? '',
      extra: { box_id: item.id },
    })
  }
  const size = typeof item.size === 'number' ? item.size : null
  const sha1 = tokenOf(item[SHA1])
  const etag = tokenOf(item.etag)
  return new FileStat({
    name: vfsName,
    size,
    type: FileType.FILE,
    content: contentTypeForPath(vfsName),
    modified: item.modified_at ?? '',
    fingerprint: sha1,
    extra: {
      box_id: item.id,
      resource_type: rt,
      ...(sha1 === null ? {} : { [SHA1]: sha1 }),
      ...(etag === null ? {} : { etag }),
    },
  })
}

/**
 * A folder's children, each as `stat` answers it. The mount root lists its
 * root folder; any other folder is listed by the id its parent's listing
 * named. Web links are bookmarks with no content endpoint and no size, so
 * they are left out. Mirrors Python's `readdir`.
 */
export async function readdir(
  accessor: BoxAccessor,
  path: PathSpec,
  entry?: FileStat | null,
): Promise<FileStat[]> {
  const target = path.pattern !== null ? path.dir : path
  let folderId: string
  if (stripSlash(target.vfsPath) === '') folderId = accessor.rootFolderId
  else if (entry === null || entry === undefined) throw enoent(path.virtual)
  else if (entry.type !== FileType.DIRECTORY) throw enotdir(path.virtual)
  else folderId = entry.extra.box_id as string
  const items = await absentOn404(path.virtual, () =>
    listFolderItems(accessor.tokenManager, folderId),
  )
  const rows = items.filter((item) => item.type !== 'web_link').map(statFromItem)
  rows.sort((a, b) => compareCodePoints(a.name, b.name))
  return rows
}
