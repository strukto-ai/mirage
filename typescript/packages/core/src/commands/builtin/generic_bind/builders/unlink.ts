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
import { extraOperandError } from '../../../spec/usage.ts'
import { IOResult } from '../../../../io/types.ts'
import { FileType } from '../../../../types.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const UNLINK_BUILDER: Builder = {
  name: 'unlink',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    if (paths.length === 0) {
      throw new UsageError("unlink: missing operand\nTry 'unlink --help' for more information.", 1)
    }
    const idx = opts.index ?? undefined
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    if (resolved.length > 1) {
      const extra = resolved[1]
      throw extraOperandError('unlink', extra === undefined ? '' : extra.rawPath)
    }
    const p = resolved[0]
    if (p === undefined) return [null, new IOResult()]
    const { unlink } = ops
    if (unlink === undefined) {
      throw new Error('unlink: remove not supported on this backend')
    }
    const enc = new TextEncoder()
    let isDir = false
    try {
      const st = await ops.stat(accessor, p, idx)
      isDir = st.type === FileType.DIRECTORY
    } catch {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: enc.encode(`unlink: cannot unlink '${p.virtual}': No such file or directory\n`),
        }),
      ]
    }
    if (isDir) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: enc.encode(`unlink: cannot unlink '${p.virtual}': Is a directory\n`),
        }),
      ]
    }
    await unlink(accessor, p)
    return [null, new IOResult()]
  },
}
