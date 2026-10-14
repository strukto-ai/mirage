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

import type { ChromaAccessor } from '../../accessor/chroma.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { ContentType, FileStat, FileType, type PathSpec } from '../../types.ts'
import { parent } from '../../utils/path.ts'
import { directoryStat } from '../slug_tree/stat.ts'
import { ensureDirSizes } from './sizes.ts'
import { CHROMA_TREE } from './tree.ts'

export async function stat(
  accessor: ChromaAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const resolved = await CHROMA_TREE.resolve(accessor, path, index)
  if (resolved.isDir) return directoryStat(resolved)
  let entry = resolved.entry
  if (entry.size === null) {
    // One scan for the whole directory, paid the first time anything in it
    // is stat'd; later stats of its siblings are already sized.
    await ensureDirSizes(accessor, parent(resolved.virtualKey), index)
    const refreshed = await index?.get(resolved.virtualKey)
    const sized = refreshed?.entry
    if (sized !== undefined && sized !== null) entry = sized
  }
  const updatedAt = entry.extra.updated_at
  return new FileStat({
    name: entry.name,
    type: FileType.FILE,
    content: ContentType.TEXT,
    size: entry.size,
    modified: typeof updatedAt === 'string' ? updatedAt : null,
    extra: { ...entry.extra },
  })
}
