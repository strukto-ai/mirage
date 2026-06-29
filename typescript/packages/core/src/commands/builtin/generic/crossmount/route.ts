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
import type { PathSpec } from '../../../../types.ts'
import { runCompare } from './compare.ts'
import { COMPARE_COMMANDS, READ_COMMANDS, TRANSFER_COMMANDS } from './detect.ts'
import { type CrossResult, type DispatchFn } from './primitives.ts'
import { runRead } from './read.ts'
import { runTransfer } from './transfer.ts'

// Run a command whose path operands span mounts, via the generics. Cross-mount
// is pure wiring: every path operand is read or written through `dispatch`
// (which routes it to its owning mount), and the shared generic command does
// the work. cp/mv go to runTransfer; diff/cmp to runCompare; the N-ary read
// commands to runRead. Returns the same (out, IOResult) a generic returns.
export async function handleCrossMount(
  cmdName: string,
  scopes: PathSpec[],
  textArgs: string[],
  flagKwargs: Record<string, string | boolean | string[]>,
  dispatch: DispatchFn,
): Promise<CrossResult> {
  try {
    if (TRANSFER_COMMANDS.has(cmdName)) {
      return await runTransfer(cmdName, scopes, flagKwargs, dispatch)
    }
    if (COMPARE_COMMANDS.has(cmdName)) {
      return await runCompare(cmdName, scopes, flagKwargs, dispatch)
    }
    if (READ_COMMANDS.has(cmdName)) {
      return await runRead(cmdName, scopes, textArgs, flagKwargs, dispatch)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: new TextEncoder().encode(`${cmdName}: ${msg}\n`) }),
    ]
  }
  const errBytes = new TextEncoder().encode(`${cmdName}: cross-mount not supported\n`)
  return [null, new IOResult({ exitCode: 1, stderr: errBytes })]
}
