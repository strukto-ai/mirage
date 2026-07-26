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

import { rekey } from '../../../../utils/key_prefix.ts'
import type { Accessor } from '../../../../accessor/base.ts'
import type { IndexCacheStore } from '../../../../cache/index/store.ts'
import { FileType, PathSpec } from '../../../../types.ts'
import { IOResult } from '../../../../io/types.ts'
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
    total += await duWalk(
      ops,
      accessor,
      index,
      PathSpec.fromStrPath(child, rekey(path.virtual, path.resourcePath, child)),
    )
  }
  return total
}

const ENC = new TextEncoder()

export const DU_BUILDER: Builder = {
  name: 'du',
  fn: async (ops, accessor, paths, _texts, opts) => {
    const idx = opts.index ?? undefined
    const { duTotal, duAll } = ops
    const resolved = paths.length > 0 ? await resolveGlobOf(ops)(accessor, paths, idx) : []
    // GNU reports an operand it cannot stat and carries on with the rest,
    // exiting 1. Walking a missing operand would report it as size 0 instead.
    const present: PathSpec[] = []
    const errors: string[] = []
    for (const p of resolved) {
      try {
        await ops.stat(accessor, p, idx)
        present.push(p)
      } catch {
        errors.push(`du: cannot access '${p.rawPath}': No such file or directory`)
      }
    }
    const err = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : undefined
    if (present.length === 0) {
      return [null, new IOResult({ exitCode: 1, ...(err !== undefined ? { stderr: err } : {}) })]
    }
    const result =
      duTotal === undefined || duAll === undefined
        ? await duMulti(present, opts, (p) => duWalk(ops, accessor, idx, p))
        : await duGeneric(
            present,
            opts,
            (p) => duTotal(accessor, p, idx),
            (p) => duAll(accessor, p, idx),
          )
    if (err === undefined || result === null) return result
    return [result[0], new IOResult({ exitCode: 1, stderr: err })]
  },
}
