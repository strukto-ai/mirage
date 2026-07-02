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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { BoxAccessor } from '../../accessor/box.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { FileType, PathSpec, type FileStat } from '../../types.ts'
import { rstripSlash } from '../../utils/slash.ts'
import { readdir } from './readdir.ts'
import { stat } from './stat.ts'

async function walkSize(
  accessor: BoxAccessor,
  path: PathSpec,
  index: IndexCacheStore | undefined,
  entries: [string, number][] | null,
): Promise<number> {
  let s: FileStat
  try {
    s = await stat(accessor, path, index)
  } catch {
    return 0
  }
  if (s.type !== FileType.DIRECTORY) {
    const size = s.size ?? 0
    if (entries !== null) {
      const prefix = mountPrefixOf(path.virtual, path.resourcePath)
      const raw = rstripSlash(path.virtual)
      const key = prefix !== '' && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
      entries.push([key, size])
    }
    return size
  }
  let children: string[]
  try {
    children = await readdir(accessor, path, index)
  } catch {
    return 0
  }
  let total = 0
  for (const child of children) {
    const trimmed = rstripSlash(child)
    const childSpec = new PathSpec({
      virtual: trimmed,
      directory: trimmed,
      resolved: false,
      resourcePath: mountKey(trimmed, mountPrefixOf(path.virtual, path.resourcePath)),
    })
    total += await walkSize(accessor, childSpec, index, entries)
  }
  return total
}

export async function du(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<number> {
  return walkSize(accessor, path, index, null)
}

export async function duAll(
  accessor: BoxAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<[[string, number][], number]> {
  const entries: [string, number][] = []
  const total = await walkSize(accessor, path, index, entries)
  return [entries, total]
}
