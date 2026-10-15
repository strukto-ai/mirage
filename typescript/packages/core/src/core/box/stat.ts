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
import { ListingCheckStore } from '../../cache/index/ram.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { enoent } from '../../errors/fs.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { stripSlash } from '../../utils/slash.ts'
import { absentOn404, getFolderInfo } from './api.ts'
import { resourceTypeFor, statFromItem } from './readdir.ts'
import { itemOf, liveItem } from './resolve.ts'

/**
 * What is at `path`: the row its parent's listing named. The mount root has
 * no parent listing to inherit an mtime from, so the folder's own metadata is
 * fetched; `find -mtime` and `ls -ld` then see a real timestamp. A fresh check
 * is answered live: by the one request the mount's row leads to, else by
 * walking the listings. `index` is the store the stat runs under; a fresh
 * check's offers the mount's rows as leads. Mirrors Python's `stat`.
 */
export async function stat(
  accessor: BoxAccessor,
  path: PathSpec,
  entry?: FileStat | null,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const key = stripSlash(path.vfsPath)
  if (key === '') {
    const info = await absentOn404(path.virtual, () =>
      getFolderInfo(accessor.tokenManager, accessor.rootFolderId),
    )
    return new FileStat({
      name: '/',
      type: FileType.DIRECTORY,
      modified: info.modified_at ?? '',
      extra: { box_id: accessor.rootFolderId },
    })
  }
  if (index instanceof ListingCheckStore) {
    const virtualKey = `${mountPrefixOf(path.virtual, path.vfsPath)}/${key}`
    // The check's store offers the mount's row as a lead, never an answer:
    // its id leads to one live request.
    const hint: unknown = await index.hint(virtualKey)
    const lead = hint instanceof FileStat ? itemOf(hint) : null
    const item = await absentOn404(path.virtual, () => liveItem(accessor, path, lead))
    // Weblinks are hidden from listings; a direct lookup must not resurface
    // a sizeless, unreadable entry.
    if (item === null || resourceTypeFor(item) === 'box/weblink') throw enoent(path.virtual)
    const row = statFromItem(item)
    // The check's store keeps what it found: a check that proves the copy
    // fresh retains it as the row the next check leads with.
    await index.put(virtualKey, row)
    return row
  }
  if (entry === null || entry === undefined) throw enoent(path.virtual)
  return entry
}
