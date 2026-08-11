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

import type { IndexCacheStore } from '../../../cache/index/store.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import type { PathSpec, ResourceNameValue } from '../../../types.ts'
import type { Accessor } from '../../../accessor/base.ts'
import { fsStrerror, isFsError } from '../../../utils/errors.ts'
import { command, type CommandFnResult, type CommandOpts, type RegisteredCommand } from '../../config.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/types.ts'
import { resolveGlobOf, type CommandIO } from '../generic_bind/index.ts'
import { formatRecords } from '../utils/output.ts'

const ENC = new TextEncoder()

type UnlinkFn<A> = (accessor: A, path: PathSpec, index?: IndexCacheStore) => Promise<void>

/**
 * Build a backend's `rm` from its glob resolver and its unlink.
 *
 * Every API-backed mount spells the same GNU behaviour: report the operand
 * it could not remove, keep removing the rest, and exit 1 if any failed.
 */
export function makeRm<A extends Accessor>(
  resource: ResourceNameValue,
  io: CommandIO<A>,
  unlink: UnlinkFn<A>,
): RegisteredCommand[] {
  const resolveGlob = resolveGlobOf(io)
  return command({
    name: 'rm',
    resource,
    spec: specOf('rm'),
    write: true,
    fn: async (
      accessor: A,
      paths: PathSpec[],
      _texts: string[],
      opts: CommandOpts,
    ): Promise<CommandFnResult> => {
      if (paths.length === 0) {
        return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('rm: missing operand\n') })]
      }
      const resolved = await resolveGlob(accessor, paths, opts.index ?? undefined)
      const fl = new FlagView(opts.flags, specOf('rm'))
      const force = fl.asBool('f')
      const verbose = fl.asBool('v')
      const verboseParts: string[] = []
      const errors: string[] = []
      const writes: Record<string, Uint8Array> = {}
      for (const p of resolved) {
        try {
          await unlink(accessor, p, opts.index ?? undefined)
        } catch (err) {
          const code = (err as { code?: string }).code
          if (force && code === 'ENOENT') continue
          if (!isFsError(err)) throw err
          // GNU rm reports the operand and keeps removing the rest.
          errors.push(`rm: cannot remove '${p.virtual}': ${String(fsStrerror(err))}`)
          continue
        }
        writes[p.mountPath] = new Uint8Array()
        if (verbose) verboseParts.push(`removed '${p.virtual}'`)
      }
      const output: ByteSource | null = verbose ? formatRecords(verboseParts) : null
      const stderr = errors.length > 0 ? ENC.encode(errors.join('\n') + '\n') : undefined
      return [
        output,
        new IOResult({
          writes,
          exitCode: errors.length > 0 ? 1 : 0,
          ...(stderr !== undefined ? { stderr } : {}),
        }),
      ]
    },
  })
}
