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
import { DEFAULT_DIR_MODE, parseChmod } from '../../../../utils/mode.ts'
import { DEFAULT_UMASK, sessionUmask } from '../../../../context/session_context.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { mkdirLinkRefusal } from '../../utils/slash_links.ts'
import { type Builder, requireOp, resolveGlobOf } from '../adapter.ts'

export const MKDIR_BUILDER: Builder = {
  name: 'mkdir',
  write: true,
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
    const { setAttrs } = ops
    const mkdir = requireOp(ops.mkdir, 'mkdir')
    let mode: number | null = null
    if (modeText !== null) {
      // Symbolic clauses build on what mirage renders for a new
      // directory; `-m` is applied after the create, so the session's
      // umask does not reach it, which is GNU's rule too.
      mode = parseChmod(modeText, DEFAULT_DIR_MODE)
      if (mode === null) throw new Error(`mkdir: invalid mode '${modeText}'`)
      if (setAttrs === undefined) {
        throw new Error('mkdir: --mode is not supported on this backend')
      }
    } else if (setAttrs !== undefined) {
      // A new directory is 0777 masked by the session's umask. Only a
      // mask away from bash's default costs a setattr, since 755 is what
      // every backend already renders for a fresh directory; parents
      // made by `-p` keep that default.
      const umask = sessionUmask()
      if (umask !== DEFAULT_UMASK) mode = 0o777 & ~umask
    }
    const resolved = await resolveGlobOf(ops)(accessor, paths, idx)
    const lines: string[] = []
    const errors: string[] = []
    const links = opts.ns?.links ?? null
    for (const p of resolved) {
      const collision = await mkdirLinkRefusal(p, links, { parents })
      if (collision.taken) {
        if (collision.message !== null) errors.push(collision.message)
        continue
      }
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
