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
import {
  errorVirtualPath,
  fsStrerror,
  isFsError,
  operandSpelling,
} from '../../../../utils/errors.ts'
import { DEFAULT_DIR_MODE, parseMode } from '../../../../utils/mode.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/types.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'

export const MKDIR_BUILDER: Builder = {
  name: 'mkdir',
  write: true,
  requirements: ['mkdir'],
  fn: async (ops, accessor, paths, _texts, opts) => {
    const fl = new FlagView(opts.flags, specOf('mkdir'))
    const parents = fl.asBool('parents')
    const verbose = fl.asBool('verbose')
    const modeText = fl.asStr('mode') ?? null
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
    const errors: string[] = []
    for (const p of resolved) {
      try {
        await mkdir(accessor, p, parents)
      } catch (err) {
        // One unusable operand is not an aborted command: GNU reports it
        // and still makes the remaining directories. The error names the path
        // to quote: usually the operand, but `mkdir -p` blames the component
        // of the chain it tripped on.
        if (!isFsError(err)) throw err
        const named = operandSpelling(errorVirtualPath(err), p)
        errors.push(`mkdir: cannot create directory '${named}': ${String(fsStrerror(err))}`)
        continue
      }
      // -m applies to the named directory only; any parents made by -p keep
      // the default mode (GNU).
      if (mode !== null && setAttrs !== undefined) await setAttrs(accessor, p, { mode })
      if (verbose) lines.push(`mkdir: created directory '${p.virtual}'`)
    }
    const out = lines.length > 0 ? new TextEncoder().encode(lines.join('\n') + '\n') : null
    const stderr = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : null
    return [out, new IOResult({ stderr, exitCode: errors.length > 0 ? 1 : 0 })]
  },
}
