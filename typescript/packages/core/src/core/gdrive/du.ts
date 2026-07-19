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

import type { GDriveAccessor } from '../../accessor/gdrive.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, type PathSpec } from '../../types.ts'
import { stat } from './stat.ts'
import { iterTree } from './tree.ts'

// Total size in bytes under a path: a file resolves from its own stat, a
// directory sums its walked descendants, mirroring the python core du.
export async function du(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<number> {
  let info
  try {
    info = await stat(accessor, path, index)
  } catch {
    info = null
  }
  if (info !== null && info.type !== FileType.DIRECTORY) return info.size ?? 0
  let total = 0
  for await (const [, item, isDir] of iterTree(accessor, path)) {
    if (!isDir) total += parseInt(item.size ?? '0', 10)
  }
  return total
}

// List of [path, size] tuples plus the walked total, in the generic du
// (entries, total) contract.
export async function duAll(
  accessor: GDriveAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<[[string, number][], number]> {
  let info
  try {
    info = await stat(accessor, path, index)
  } catch {
    info = null
  }
  if (info !== null && info.type !== FileType.DIRECTORY) {
    return [[], info.size ?? 0]
  }
  const entries: [string, number][] = []
  let total = 0
  for await (const [rel, item, isDir] of iterTree(accessor, path)) {
    if (isDir) continue
    const size = parseInt(item.size ?? '0', 10)
    entries.push(['/' + rel, size])
    total += size
  }
  return [entries, total]
}
