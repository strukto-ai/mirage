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

import type { Accessor } from '../../accessor/base.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import { isEnoent } from '../../errors/fs.ts'
import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DuEntries, DuOps, ReaddirOp, StatOp } from '../../vfs/types.ts'

/**
 * Sum file sizes under a path through readdir and stat. Only absence counts
 * as zero; any other failure propagates rather than under-reporting the
 * total. Mirrors Python's `walk`.
 */
export async function walk<A extends Accessor>(
  stat: StatOp<A>,
  readdir: ReaddirOp<A>,
  accessor: A,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  results: [string, number][] | null,
): Promise<number> {
  let info: FileStat
  try {
    info = await stat(accessor, path, index)
  } catch (err) {
    if (!isEnoent(err)) throw err
    return 0
  }
  const prefix = mountPrefixOf(path.virtual, path.vfsPath)
  if (info.type !== FileType.DIRECTORY) {
    const size = info.size ?? 0
    results?.push(['/' + mountKey(path.virtual, prefix), size])
    return size
  }
  let children: string[]
  try {
    children = await readdir(accessor, path, index)
  } catch (err) {
    if (!isEnoent(err)) throw err
    return 0
  }
  let total = 0
  for (const child of children) {
    const trimmed = rstripSlash(child)
    const childSpec = new PathSpec({
      virtual: trimmed,
      directory: trimmed,
      resolved: false,
      vfsPath: mountKey(trimmed, prefix),
    })
    total += await walk(stat, readdir, accessor, childSpec, index, results)
  }
  return total
}

/** A native `du` that walks the backend's own readdir and stat. Mirrors Python's `make_walked_du`. */
export function makeWalkedDu<A extends Accessor>(stat: StatOp<A>, readdir: ReaddirOp<A>): DuOps<A> {
  return {
    size: (accessor, path, index) => walk(stat, readdir, accessor, path, index, null),
    entries: async (accessor, path, index): Promise<DuEntries> => {
      let info: FileStat | null
      try {
        info = await stat(accessor, path, index)
      } catch (err) {
        if (!isEnoent(err)) throw err
        info = null
      }
      if (info !== null && info.type !== FileType.DIRECTORY) return [[], info.size ?? 0]
      const found: [string, number][] = []
      const total = await walk(stat, readdir, accessor, path, index, found)
      found.sort(([a], [b]) => compareCodePoints(a, b))
      return [found, total]
    },
  }
}
