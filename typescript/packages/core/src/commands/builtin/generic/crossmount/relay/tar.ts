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

import { IOResult } from '../../../../../io/types.ts'
import type { NamespaceView } from '../../../../../ops/types.ts'
import type { PathSpec } from '../../../../../types.ts'
import { specOf } from '../../../../spec/builtins.ts'
import { FlagView } from '../../../../spec/flag_view.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { rstripSlash } from '../../../../../utils/slash.ts'
import { relayIsDirOf, relayWalkOf } from '../../../generic_bind/archive_io.ts'
import { tarGeneric } from '../../tar.ts'
import { crossOpts, flatten, statOp, streamOp } from '../utils.ts'
import type { CrossResult, DispatchFn } from '../types.ts'

// The positional operands among a line's path words. The scopes are every
// path word in line order, an option's value among them. The parser gives
// each option its word first (POSIX order, and the order -C needs), so the
// same words go here and what is left are the operands, each with its own
// spelling.
function operands(scopes: readonly PathSpec[], taken: readonly string[]): PathSpec[] {
  const rest = [...scopes]
  for (const value of taken) {
    const key = rstripSlash(value) || '/'
    const index = rest.findIndex((scope) => (rstripSlash(scope.virtual) || '/') === key)
    if (index >= 0) rest.splice(index, 1)
  }
  return rest
}

/**
 * Run a tar whose archive, operands and -C destination span mounts.
 *
 * Pure wiring: the shared generic runs on dispatch-relayed doors, so the
 * archive is read from or written to its mount, every extracted path lands
 * on whichever mount owns it, and each -c operand is walked on the mount
 * that owns it. The create scan still stops at a mount nested under an
 * operand, exactly as it does on one mount.
 */
export async function runTar(
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, FlagValue>,
  dispatch: DispatchFn,
  // The symlinks and mount boundaries the create scan merges into each walk.
  ns?: NamespaceView,
): Promise<CrossResult> {
  const fl = new FlagView(flagKwargs, specOf('tar'))
  const archive = fl.asStr('f') ?? null
  const created =
    archive !== null && fl.asBool('c') ? operands(scopes, [archive, ...fl.asList('C')]) : []
  const result = await tarGeneric(
    flatten(created),
    textArgs,
    { ...crossOpts(flagKwargs), ...(ns !== undefined ? { ns } : {}) },
    {
      stream: streamOp(dispatch),
      write: async (p, data) => {
        await dispatch('write', p, [data])
      },
      mkdir: async (p) => {
        await dispatch('mkdir', p)
      },
      stat: statOp(dispatch),
      walk: relayWalkOf(dispatch, ns?.childMounts),
      isDir: relayIsDirOf(dispatch),
    },
    true,
  )
  return result ?? [null, new IOResult()]
}
