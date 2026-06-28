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

import type { Accessor } from '../../../accessor/base.ts'
import { IOResult } from '../../../io/types.ts'
import { PathSpec, type ResourceName } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { command, type CommandFnResult, type CommandOpts } from '../../config.ts'
import { resolvePath } from '../../spec/parser.ts'
import { specOf } from '../../spec/builtins.ts'
import { sedGeneric } from './sed.ts'

const ENC = new TextEncoder()

/**
 * When the script is supplied via -e/-f, GNU sed treats every bare argument as
 * a file. The arg parser instead routes the first bare arg into the positional
 * `text` (script) slot, so recover it as a path operand here.
 */
function positionalAsPaths(texts: string[], opts: CommandOpts): PathSpec[] {
  const prefix = opts.mountPrefix !== undefined ? rstripSlash(opts.mountPrefix) : ''
  return texts.map((t) => {
    const resolved = resolvePath(opts.cwd, t)
    const slash = resolved.lastIndexOf('/')
    return new PathSpec({
      original: resolved,
      directory: slash >= 0 ? resolved.slice(0, slash + 1) : '/',
      resolved: true,
      prefix,
    })
  })
}

/**
 * Per-backend hooks for the shared `sed` command. Every backend's `sed` is the
 * same logic over the generic engine differing only in how bytes are read and
 * (optionally) written, whether globs are resolved, and whether the mount is
 * read-only. `makeSed` captures that so each backend is a small config.
 */
export interface SedBackend<A extends Accessor> {
  /** Resource name(s) this command is registered for. */
  resource: ResourceName | ResourceName[]
  /** Stream a path's bytes. `opts` carries the index for index-aware reads. */
  stream: (accessor: A, p: PathSpec, opts: CommandOpts) => AsyncIterable<Uint8Array>
  /** Write bytes back (for `-i`). Omit for read-only mounts. */
  write?: (accessor: A, p: PathSpec, data: Uint8Array) => Promise<void>
  /** Expand globs in the path operands. Omit for backends without glob support. */
  glob?: (accessor: A, paths: PathSpec[], opts: CommandOpts) => Promise<PathSpec[]>
  /** Human-readable mount name used in the read-only `-i` rejection message. */
  readOnlyMount?: string
}

export function makeSed<A extends Accessor>(backend: SedBackend<A>) {
  const { resource, stream, write, glob, readOnlyMount } = backend
  return command<A>({
    name: 'sed',
    resource,
    spec: specOf('sed'),
    fn: async (
      accessor: A,
      paths: PathSpec[],
      texts: string[],
      opts: CommandOpts,
    ): Promise<CommandFnResult> => {
      if (write === undefined && opts.flags.i === true) {
        return [
          null,
          new IOResult({
            exitCode: 1,
            stderr: ENC.encode(
              `sed -i not supported on read-only ${readOnlyMount ?? 'this'} mount\n`,
            ),
          }),
        ]
      }
      // With -e/-f the positional operand is a file, not the script (see above).
      const usingE = opts.flags.e !== undefined && opts.flags.e !== false
      const usingF = opts.flags.f !== undefined && opts.flags.f !== false
      const operands = usingE || usingF ? [...positionalAsPaths(texts, opts), ...paths] : paths
      const resolved =
        glob !== undefined && operands.length > 0 ? await glob(accessor, operands, opts) : operands
      const writeFn =
        write ??
        ((): Promise<void> =>
          Promise.reject(new Error(`sed: ${readOnlyMount ?? 'this'} mount is read-only`)))
      return sedGeneric(
        resolved,
        texts,
        opts,
        (p) => stream(accessor, p, opts),
        (p, d) => writeFn(accessor, p, d),
      )
    },
  })
}
