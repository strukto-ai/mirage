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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { toIsoZ } from '../../utils/dates.ts'
import { contentTypeForPath } from '../../utils/filetype.ts'
import { rawPathOf } from '../../utils/key_prefix.ts'
import { ancestors, norm } from '../../utils/path.ts'
import { statEntry } from './client.ts'
import { kindsOf, lookupError } from './dest.ts'
import { hasStatus } from './errors.ts'
import { backendPath } from './path.ts'
import type { Entry } from './types.ts'

export function fileStat(entry: Entry): FileStat {
  const modified =
    entry.mtime !== null && entry.mtime !== 0 ? toIsoZ(new Date(entry.mtime * 1000)) : null
  if (entry.isDir) return new FileStat({ name: entry.name, modified, type: FileType.DIRECTORY })
  return new FileStat({
    name: entry.name,
    size: entry.size,
    modified,
    type: FileType.FILE,
    content: contentTypeForPath(entry.name),
  })
}

/**
 * A path's metadata from one HEAD; a trailing slash asks for the directory
 * of that name, as it does on an object store.
 */
export async function stat(accessor: TiDBFilesystemAccessor, path: PathSpec): Promise<FileStat> {
  const key = norm(path.mountPath)
  if (key === '/') return new FileStat({ name: '/', type: FileType.DIRECTORY })
  const directory = rawPathOf(path).endsWith('/')
  let entry: Entry
  try {
    entry = await statEntry(accessor, backendPath(accessor.config, path), directory)
  } catch (exc) {
    if (!hasStatus(exc, 404)) throw exc
    const kinds = await kindsOf(accessor, [...ancestors(key), key])
    const found = kinds.get(key) ?? null
    if (directory && found !== null && !found.isDir) throw enotdir(path)
    throw lookupError(kinds, path, key)
  }
  return fileStat(entry)
}
