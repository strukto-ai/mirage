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

import type { TiDBFilesystemAccessor } from '../../accessor/tidb_filesystem.ts'
import { enotdir } from '../../errors/fs.ts'
import type { FileStat, PathSpec } from '../../types.ts'
import { ancestors, norm } from '../../utils/path.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import { listEntries } from './client.ts'
import { folderOf, kindsOf, lookupError } from './dest.ts'
import { backendPath } from './path.ts'
import { fileStat } from './stat.ts'

/**
 * A folder's rows from one listing, sorted by name. drive9 lists a missing
 * folder as an empty one, so only an empty listing asks what the path is. A
 * name that is both a file and a directory lists once, as the directory, as
 * it does on an object store.
 */
export async function readdir(
  accessor: TiDBFilesystemAccessor,
  path: PathSpec,
): Promise<FileStat[]> {
  const listPath = path.pattern !== null ? path.dir : path
  const key = norm(listPath.mountPath)
  const entries = await listEntries(accessor, backendPath(accessor.config, listPath))
  if (entries.length === 0) {
    const kinds = await kindsOf(accessor, [...ancestors(key), key])
    const found = folderOf(kinds, key)
    if (found === null) throw lookupError(kinds, listPath, key)
    if (!found.isDir) throw enotdir(listPath)
    return []
  }
  const rows = new Map(
    [...entries]
      .sort((a, b) => Number(a.isDir) - Number(b.isDir))
      .map((entry) => [entry.name, fileStat(entry)] as const),
  )
  return [...rows].sort(([a], [b]) => compareCodePoints(a, b)).map(([, row]) => row)
}
