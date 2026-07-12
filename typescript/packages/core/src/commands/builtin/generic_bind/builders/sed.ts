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

import { mountKey } from '../../../../utils/key_prefix.ts'
import { IOResult } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import { resolvePath } from '../../../../utils/path.ts'
import { rstripSlash } from '../../../../utils/slash.ts'
import type { CommandOpts } from '../../../config.ts'
import { sedGeneric } from '../../generic/sed.ts'
import { type Builder, resolveGlobOf } from '../adapter.ts'
import { makeSedProvision } from '../provision.ts'

const ENC = new TextEncoder()

/**
 * When the script is supplied via -e/-f, GNU sed treats every bare argument as
 * a file. The arg parser instead routes the first bare arg into the positional
 * `text` (script) slot, so recover it as a path operand here.
 */
function positionalAsPaths(texts: string[], opts: CommandOpts): PathSpec[] {
  const prefix = opts.mountPrefix !== undefined ? rstripSlash(opts.mountPrefix) : ''
  return texts.map((t) => {
    const resolved = resolvePath(t, opts.cwd)
    const slash = resolved.lastIndexOf('/')
    return new PathSpec({
      virtual: resolved,
      directory: slash >= 0 ? resolved.slice(0, slash + 1) : '/',
      resolved: true,
      resourcePath: mountKey(resolved, prefix),
    })
  })
}

export const SED_BUILDER: Builder = {
  name: 'sed',
  provision: makeSedProvision,
  fn: async (ops, accessor, paths, texts, opts) => {
    const idx = opts.index ?? undefined
    const { write } = ops
    // The default stream-to-stdout path is read-only and works on every
    // backend; only in-place editing needs a write op (#382).
    if (opts.flags.i === true && write === undefined) {
      return [
        null,
        new IOResult({
          exitCode: 1,
          stderr: ENC.encode('sed: -i not supported on this backend: Permission denied\n'),
        }),
      ]
    }
    // With -e/-f the positional operand is a file, not the script.
    const usingE = opts.flags.e !== undefined && opts.flags.e !== false
    const usingF = opts.flags.f !== undefined && opts.flags.f !== false
    const operands = usingE || usingF ? [...positionalAsPaths(texts, opts), ...paths] : paths
    const resolved =
      operands.length > 0 ? await resolveGlobOf(ops)(accessor, operands, idx) : operands
    return sedGeneric(
      resolved,
      texts,
      opts,
      (p) => ops.readStream(accessor, p, idx),
      (p, d) => {
        if (write === undefined) {
          return Promise.reject(
            new Error('sed: -i not supported on this backend: Permission denied'),
          )
        }
        return write(accessor, p, d)
      },
    )
  },
}
