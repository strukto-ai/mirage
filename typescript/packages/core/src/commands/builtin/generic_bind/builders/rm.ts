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

import { IOResult } from '../../../../io/types.ts'
import { FileType } from '../../../../types.ts'
import { formatRecords } from '../../utils/output.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const RM_BUILDER: Builder = {
  name: 'rm',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    if (paths.length === 0) {
      return [
        null,
        new IOResult({ exitCode: 1, stderr: new TextEncoder().encode('rm: missing operand\n') }),
      ]
    }
    const idx = opts.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const recursive = opts.flags.r === true || opts.flags.R === true
    const force = opts.flags.f === true
    const verbose = opts.flags.v === true
    const { rmR, rmdir, unlink } = ops
    if (rmR === undefined || rmdir === undefined || unlink === undefined) {
      throw new Error('rm: backend provides no remove op')
    }
    const lines: string[] = []
    for (const p of resolved) {
      let isDir = false
      try {
        const st = await ops.stat(accessor, p, idx)
        isDir = st.type === FileType.DIRECTORY
      } catch {
        if (force) continue
        throw new Error(`rm: cannot remove '${p.original}': No such file or directory`)
      }
      if (isDir) {
        if (recursive) {
          await rmR(accessor, p)
        } else {
          await rmdir(accessor, p)
        }
      } else {
        await unlink(accessor, p)
      }
      if (verbose) lines.push(`removed '${p.original}'`)
    }
    const out = lines.length > 0 ? formatRecords(lines) : null
    return [out, new IOResult()]
  },
}
