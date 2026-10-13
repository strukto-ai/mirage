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

import type { RAMAccessor } from '../../accessor/ram.ts'
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { gnuBasename, norm } from '../../utils/path.ts'
import { lookupError } from './dest.ts'
import type { RAMStore } from '../../vfs/ram/store.ts'

/**
 * What `stat` answers for the normalized key `p`, null when nothing is there.
 * Mirrors Python's `key_stat`.
 */
export function keyStat(store: RAMStore, p: string): FileStat | null {
  const attrs = store.attrs.get(p) ?? {}
  if (store.dirs.has(p)) {
    return new FileStat({
      name: gnuBasename(p),
      modified: store.modified.get(p) ?? null,
      type: FileType.DIRECTORY,
      mode: attrs.mode ?? null,
      uid: attrs.uid ?? null,
      gid: attrs.gid ?? null,
      atime: attrs.atime ?? null,
    })
  }
  const data = store.files.get(p)
  if (data === undefined) return null
  return new FileStat({
    name: gnuBasename(p),
    size: data.byteLength,
    modified: store.modified.get(p) ?? null,
    type: FileType.FILE,
    content: contentTypeForPath(p),
    mode: attrs.mode ?? null,
    uid: attrs.uid ?? null,
    gid: attrs.gid ?? null,
    atime: attrs.atime ?? null,
  })
}

export function stat(accessor: RAMAccessor, path: PathSpec): Promise<FileStat> {
  const p = norm(path.mountPath)
  const found = keyStat(accessor.store, p)
  if (found === null) throw lookupError(accessor, path, p)
  return Promise.resolve(found)
}
