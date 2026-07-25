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
import { DEFAULT_DIR_MODE, parseMode } from '../../../../utils/mode.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const MKDIR_BUILDER: Builder = {
  name: 'mkdir',
  write: true,
  fn: async (ops, accessor, paths, _texts, opts) => {
    const parents = opts.flags.p === true || opts.flags.parents === true
    const verbose = opts.flags.v === true || opts.flags.verbose === true
    const modeFlag = opts.flags.m ?? opts.flags.mode
    const modeText = typeof modeFlag === 'string' ? modeFlag : null
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
    const { mkdir, setAttrs } = ops
    if (mkdir === undefined) {
      throw new Error('mkdir: backend provides no mkdir op')
    }
    let mode: number | null = null
    if (modeText !== null) {
      // Symbolic clauses build on what mirage renders for a new directory,
      // since there is no umask to subtract from.
      mode = parseMode(modeText, DEFAULT_DIR_MODE)
      if (mode === null) throw new Error(`mkdir: invalid mode '${modeText}'`)
      if (setAttrs === undefined) {
        throw new Error('mkdir: --mode is not supported on this backend')
      }
    }
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const lines: string[] = []
    for (const p of resolved) {
      await mkdir(accessor, p, parents)
      // -m applies to the named directory only; any parents made by -p keep
      // the default mode (GNU).
      if (mode !== null && setAttrs !== undefined) await setAttrs(accessor, p, { mode })
      if (verbose) lines.push(`mkdir: created directory '${p.virtual}'`)
    }
    const out = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
    return [out, new IOResult()]
  },
}
