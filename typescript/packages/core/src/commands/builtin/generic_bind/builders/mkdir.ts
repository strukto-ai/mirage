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
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const MKDIR_BUILDER: Builder = {
  name: 'mkdir',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    const parents = opts.flags.p === true
    const verbose = opts.flags.v === true
    if (paths.length === 0) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: new TextEncoder().encode('mkdir: missing operand\n'),
        }),
      ]
    }
    const idx = opts.index ?? undefined
    const { mkdir } = ops
    if (mkdir === undefined) {
      throw new Error('mkdir: backend provides no mkdir op')
    }
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const lines: string[] = []
    for (const p of resolved) {
      await mkdir(accessor, p, parents)
      if (verbose) lines.push(`mkdir: created directory '${p.original}'`)
    }
    const out = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
    return [out, new IOResult()]
  },
}
