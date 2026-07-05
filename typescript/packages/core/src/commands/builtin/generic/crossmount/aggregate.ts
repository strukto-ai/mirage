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
import { FileType, PathSpec } from '../../../../types.ts'
import { duMulti } from '../du.ts'
import { fileGeneric } from '../file.ts'
import { md5Generic } from '../md5.ts'
import {
  type CrossResult,
  type DispatchFn,
  crossOpts,
  readBytesOp,
  readdirOp,
  statOp,
  streamOp,
} from './primitives.ts'

// Total bytes under one operand via relayed stat/readdir. Mirrors the
// factory du builder's walk fallback for backends without a native du
// op, so cross-mount totals match single-mount ones.
async function duWalk(dispatch: DispatchFn, path: PathSpec): Promise<number> {
  const stat = statOp(dispatch)
  let s
  try {
    s = await stat(path)
  } catch {
    return 0
  }
  if (s.type !== FileType.DIRECTORY) return s.size ?? 0
  let children: string[]
  try {
    children = await readdirOp(dispatch)(path)
  } catch {
    return 0
  }
  let total = 0
  for (const child of children) {
    total += await duWalk(dispatch, PathSpec.fromStrPath(child))
  }
  return total
}

/**
 * Run a per-operand aggregating command whose operands span mounts.
 * Pure wiring: every operand is stat'd or read via `dispatch`-relayed
 * primitives on its owning mount, and the shared generic (du/md5/file)
 * formats the output, so it matches the single-mount commands line for
 * line. du totals come from the same walk the factory builder uses for
 * backends without a native du op; -a/-s/--max-depth collapse to one
 * line per operand there, and do the same here.
 */
export async function runAggregate(
  cmdName: string,
  scopes: PathSpec[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  const opts = crossOpts(flagKwargs)
  if (cmdName === 'du') {
    return (await duMulti(scopes, opts, (p) => duWalk(dispatch, p))) ?? [null, new IOResult()]
  }
  if (cmdName === 'md5') {
    return (await md5Generic(scopes, opts, streamOp(dispatch))) ?? [null, new IOResult()]
  }
  return (
    (await fileGeneric(scopes, opts, statOp(dispatch), readBytesOp(dispatch))) ?? [
      null,
      new IOResult(),
    ]
  )
}
