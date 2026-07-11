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

import { rekey } from '../../../utils/key_prefix.ts'
import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { FileType, PathSpec, type FileStat } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'

export type StatFn = (path: PathSpec, index?: IndexCacheStore) => Promise<FileStat>

export type BackendKeyFn = (path: PathSpec) => string

export function backendKeyDefault(path: PathSpec): string {
  return rstripSlash(path.mountPath)
}

function childPath(parent: PathSpec, name: string): PathSpec {
  const child = `${rstripSlash(parent.virtual)}/${name}`
  return PathSpec.fromStrPath(child, rekey(parent.virtual, parent.resourcePath, child))
}

export function copyTargets(
  sources: PathSpec[],
  dst: PathSpec,
  dstIsDir: boolean,
): [PathSpec, PathSpec][] {
  if (sources.length > 1 && !dstIsDir) {
    throw new Error(`target '${dst.virtual}' is not a directory`)
  }
  if (!dstIsDir) {
    const first = sources[0]
    return first === undefined ? [] : [[first, dst]]
  }
  return sources.map((src): [PathSpec, PathSpec] => {
    const name = rstripSlash(src.mountPath).split('/').pop() ?? ''
    return [src, childPath(dst, name)]
  })
}

export async function pathExists(stat: StatFn, path: PathSpec): Promise<boolean> {
  try {
    await stat(path)
  } catch {
    return false
  }
  return true
}

export async function isDirectory(
  stat: StatFn,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<boolean> {
  try {
    const info = await stat(path, index)
    return info.type === FileType.DIRECTORY
  } catch {
    return false
  }
}
