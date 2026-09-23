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
import { ExitSignal } from '../../../../shell/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { ReturnSignal } from '../../../../shell/errors.ts'
import { isCountWord } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { BreakSignal, ContinueSignal } from '../../control.ts'

// Parse the optional numeric level of `break`/`continue`.
export function loopLevels(args: readonly string[]): number {
  const first = args[0]
  if (first !== undefined && /^\d+$/.test(first) && parseInt(first, 10) > 0) {
    return parseInt(first, 10)
  }
  return 1
}

/** `true`: succeed and print nothing. */
export function handleTrue(): Result {
  return [null, new IOResult(), new ExecutionNode({ command: 'true', exitCode: 0 })]
}

/** `:`: succeed and print nothing (the null command). */
export function handleColon(): Result {
  return [null, new IOResult(), new ExecutionNode({ command: ':', exitCode: 0 })]
}

/** `false`: fail with 1 and print nothing. */
export function handleFalse(): Result {
  return [null, new IOResult({ exitCode: 1 }), new ExecutionNode({ command: 'false', exitCode: 1 })]
}

/** Return from a function or sourced script, with bash's checks. */
export function handleReturn(
  args: readonly string[],
  session: SessionState,
  callStack: CallStack | null = null,
): Result {
  const inFunction = callStack !== null && callStack.depth > 1
  if (!inFunction && session.sourceDepth === 0) {
    // bash prints the diagnostic, sets $? to 2, and carries on with
    // the rest of the line.
    const err = new TextEncoder().encode(
      "return: can only `return' from a function or sourced script\n",
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 2, stderr: err }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isCountWord(first)) {
    // bash prints the error and the function returns 2.
    throw new ReturnSignal(
      2,
      new TextEncoder().encode(`return: ${first}: numeric argument required\n`),
    )
  }
  if (args.length > 1) {
    const err = new TextEncoder().encode('return: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 1, stderr: err }),
    ]
  }
  // A bare return propagates the status of the last command executed.
  throw new ReturnSignal(
    first !== undefined ? ((Number(first) % 256) + 256) % 256 : session.lastExitCode,
  )
}

/** Exit the shell, with bash's argument checks. */
export function handleExit(args: readonly string[], session: SessionState): Result {
  const first = args[0]
  if (first !== undefined && !isCountWord(first)) {
    // bash exits with 2 after the diagnostic.
    throw new ExitSignal(2, new TextEncoder().encode(`exit: ${first}: numeric argument required\n`))
  }
  if (args.length > 1) {
    // bash refuses to exit and the command fails with 1.
    const err = new TextEncoder().encode('exit: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'exit', exitCode: 1, stderr: err }),
    ]
  }
  const code = first !== undefined ? Number(first) : session.lastExitCode
  throw new ExitSignal(((code % 256) + 256) % 256)
}

/** The `true` arm. */
export function trueBuiltin(_call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleTrue())
}

/** The `:` arm. */
export function colonBuiltin(_call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleColon())
}

/** The `false` arm. */
export function falseBuiltin(_call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleFalse())
}

/** The `return` arm. */
export function returnBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleReturn([...call.argv.args], call.session, call.callStack))
}

/** The `exit` arm. */
export function exitBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleExit([...call.argv.args], call.session))
}

/** The `break` arm: unwinds the enclosing loops by throwing. */
export function breakBuiltin(call: BuiltinCall): Promise<Result> {
  throw new BreakSignal(null, new IOResult(), loopLevels([...call.argv.args]))
}

/** The `continue` arm: unwinds to the next iteration by throwing. */
export function continueBuiltin(call: BuiltinCall): Promise<Result> {
  throw new ContinueSignal(null, new IOResult(), loopLevels([...call.argv.args]))
}
