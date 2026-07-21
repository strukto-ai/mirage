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

import { UsageError } from '../../../errors.ts'
import { IOResult } from '../../../../io/types.ts'
import { FileType } from '../../../../types.ts'
import { formatRecords } from '../../utils/output.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const RMDIR_BUILDER: Builder = {
  name: 'rmdir',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    if (paths.length === 0) {
      throw new UsageError("rmdir: missing operand\nTry 'rmdir --help' for more information.", 1)
    }
    const idx = opts.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const verbose = opts.flags.v === true
    const { rmdir } = ops
    if (rmdir === undefined) {
      throw new Error('rmdir: directory remove not supported on this backend')
    }
    const lines: string[] = []
    const errors: string[] = []
    for (const p of resolved) {
      let isDir = false
      try {
        const st = await ops.stat(accessor, p, idx)
        isDir = st.type === FileType.DIRECTORY
      } catch {
        errors.push(`rmdir: failed to remove '${p.virtual}': No such file or directory`)
        continue
      }
      if (!isDir) {
        errors.push(`rmdir: failed to remove '${p.virtual}': Not a directory`)
        continue
      }
      if ((await ops.readdir(accessor, p, idx)).length > 0) {
        errors.push(`rmdir: failed to remove '${p.virtual}': Directory not empty`)
        continue
      }
      await rmdir(accessor, p)
      if (verbose) lines.push(`rmdir: removing directory, '${p.virtual}'`)
    }
    const out = lines.length > 0 ? formatRecords(lines) : null
    const stderr =
      errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : undefined
    return [
      out,
      new IOResult({
        exitCode: errors.length > 0 ? 1 : 0,
        ...(stderr !== undefined ? { stderr } : {}),
      }),
    ]
  },
}
