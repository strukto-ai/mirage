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
import { FileStat, FileType, type PathSpec } from '../../types.ts'
import { parent } from '../../utils/path.ts'
import { treeStat } from '../slug_tree/stat.ts'
import { ensureDirSizes } from './sizes.ts'
import { rstripSlash } from '../../utils/slash.ts'

/** Stat a path, sizing a page its listing left unsized. */
export async function stat(
  accessor: ChromaAccessor,
  path: PathSpec,
  entry: FileStat | null = null,
  index?: IndexCacheStore,
): Promise<FileStat> {
  const row = treeStat(path, entry)
  if (row.type !== FileType.FILE || row.size !== null || index === undefined) return row
  // One scan for the whole directory, paid the first time anything in it is
  // stat'd; later stats of its siblings are already sized.
  const key = rstripSlash(path.virtual)
  await ensureDirSizes(accessor, parent(key), index)
  const sized: unknown = (await index.get(key)).entry
  return sized instanceof FileStat ? sized : row
}
