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

import type { Accessor } from '../../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import { duGeneric, duMulti } from '../../generic/du.ts'
import { type Builder, type CommandIO, resolveGlobOf } from '../adapter.ts'

async function duWalk(
  ops: CommandIO,
  accessor: Accessor,
  index: IndexCacheStore | undefined,
  path: PathSpec,
): Promise<number> {
  let info
  try {
    info = await ops.stat(accessor, path, index)
  } catch {
    return 0
  }
  if (info.type !== FileType.DIRECTORY) return info.size ?? 0
  let children: string[]
  try {
    children = await ops.readdir(accessor, path, index)
  } catch {
    return 0
  }
  let total = 0
  for (const child of children) {
    total += await duWalk(ops, accessor, index, PathSpec.fromStrPath(child, path.prefix))
  }
  return total
}

export const DU_BUILDER: Builder = {
  name: 'du',
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    const { duTotal, duAll } = ops
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    if (duTotal === undefined || duAll === undefined) {
      return duMulti(resolved, opts, (p) => duWalk(ops, accessor, idx, p))
    }
    return duGeneric(
      resolved,
      opts,
      (p) => duTotal(accessor, p, idx),
      (p) => duAll(accessor, p, idx),
    )
  },
}
