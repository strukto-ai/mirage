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
import type { CallStack } from '../../../../shell/call_stack.ts'
import type { SessionState } from '../../../session/session.ts'
import { positionalParams, setPositionalParams } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { ExitSignal } from '../../../../shell/errors.ts'
import { builtinError, isCountWord, numericOperands } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'

/**
 * Shift positional parameters, with bash's argument checks: a count past
 * `$#` shifts nothing and exits 1 with no message, a negative count is
 * `shift count out of range`, and a non-numeric word is `numeric argument
 * required`; every other case exits 0.
 */
export function handleShift(
  args: readonly string[],
  callStack: CallStack | null,
  session: SessionState,
): Result {
  const words = numericOperands(args)
  const first = words[0]
  if (first !== undefined && !isCountWord(first)) {
    const err = builtinError('shift', `${first}: numeric argument required`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  // bash abandons everything still to run, as `exit 1 2` does.
  if (words.length > 1) throw new ExitSignal(1, builtinError('shift', 'too many arguments'))
  const n = first !== undefined ? Number(first.trim()) : 1
  if (n < 0) {
    const err = builtinError('shift', `${first ?? ''}: shift count out of range`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const params = positionalParams(session, callStack)
  // bash: a count past `$#` shifts nothing and returns 1, silently.
  if (n > params.length) {
    return [
      null,
      new IOResult({ exitCode: 1 }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  setPositionalParams(session, callStack, params.slice(n))
  return [null, new IOResult(), new ExecutionNode({ command: 'shift', exitCode: 0 })]
}

/** The `shift` arm. */
export function shiftBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleShift([...call.argv.args], call.callStack, call.context.session))
}
