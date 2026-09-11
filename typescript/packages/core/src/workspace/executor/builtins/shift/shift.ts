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
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { isCountWord } from '../shared.ts'
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
  session: Session | null = null,
): Result {
  if (args.length > 1) {
    const err = new TextEncoder().encode('shift: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isCountWord(first)) {
    const err = new TextEncoder().encode(`shift: ${first}: numeric argument required\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const n = first !== undefined ? Number(first) : 1
  if (n < 0) {
    const err = new TextEncoder().encode(`shift: ${first ?? ''}: shift count out of range\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  // bash: a count past `$#` shifts nothing and returns 1, silently.
  const silentOne: Result = [
    null,
    new IOResult({ exitCode: 1 }),
    new ExecutionNode({ command: 'shift', exitCode: 1 }),
  ]
  if (callStack !== null && callStack.getAllPositional().length > 0) {
    if (n > callStack.getPositionalCount()) return silentOne
    callStack.shift(n)
  } else if (session !== null) {
    if (n > session.positionalArgs.length) return silentOne
    session.positionalArgs = session.positionalArgs.slice(n)
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'shift', exitCode: 0 })]
}

/** The `shift` arm. */
export function shiftBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleShift([...call.argv.args], call.callStack, call.session))
}
