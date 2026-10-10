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

import { concat } from '../../../../utils/bytes.ts'
import { IOResult, type ByteSource } from '../../../../io/types.ts'
import type { CallStack } from '../../../../shell/call_stack.ts'
import { ExitSignal } from '../../../../shell/errors.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { ReturnSignal } from '../../../../shell/errors.ts'
import { builtinError, isCountWord, numericOperands, statusOf } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { BreakSignal, ContinueSignal } from '../../control.ts'
import { runExitTrap } from '../../traps.ts'
import type { ExecuteFn } from '../../../expand/node.ts'

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

/**
 * Return from a function or sourced script, with bash's checks. bash reads
 * the status before it looks for a function to leave, so a bad one is
 * reported even where `return` then refuses; a pushed frame (a function's or
 * a sourced file's) is what returns.
 */
export function handleReturn(
  args: readonly string[],
  session: SessionState,
  callStack: CallStack | null = null,
): Result {
  const words = numericOperands(args)
  const first = words[0]
  let status = session.lastExitCode
  let err: Uint8Array = new Uint8Array()
  if (first !== undefined && !isCountWord(first)) {
    err = builtinError('return', `${first}: numeric argument required`)
    status = 2
  } else if (words.length > 1) {
    // bash abandons everything still to run, as `exit 1 2` does.
    throw new ExitSignal(1, builtinError('return', 'too many arguments'))
  } else if (first !== undefined) {
    status = statusOf(first)
  }
  if (!callStack?.returnable) {
    // bash prints the diagnostic, sets $? to 2, and carries on with the
    // rest of the line.
    err = concat([
      err,
      builtinError('return', "can only `return' from a function or sourced script"),
    ])
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 2, stderr: err }),
    ]
  }
  throw new ReturnSignal(status, err)
}

/**
 * Exit the shell, with bash's argument checks, running its EXIT action
 * first, where `exit` was called: a function's locals and `$1` are still in
 * scope, as they are for bash's. `stdin` is the shell's input, which the
 * action reads; `callStack` holds the frames `exit` was called in.
 */
export async function handleExit(
  args: readonly string[],
  session: SessionState,
  executeFn: ExecuteFn | null = null,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const words = numericOperands(args)
  const first = words[0]
  let code: number
  let err: Uint8Array = new Uint8Array()
  if (first !== undefined && !isCountWord(first)) {
    // bash exits with 2 after the diagnostic.
    code = 2
    err = builtinError('exit', `${first}: numeric argument required`)
  } else if (words.length > 1) {
    // bash abandons everything still to run, and exits nowhere.
    code = 1
    err = builtinError('exit', 'too many arguments')
  } else if (first !== undefined) {
    code = statusOf(first)
  } else {
    code = (session.trapStatus ?? session.lastExitCode) % 256
  }
  const cleanup = await runExitTrap(executeFn, session, code, stdin, callStack)
  if (cleanup === null) throw new ExitSignal(code, err)
  const leaving = new ExitSignal(
    cleanup.exitCode,
    concat([err, await cleanup.materializeStderr()]),
    await cleanup.materializeStdout(),
  )
  leaving.cleanup = leaving.stdout ?? new Uint8Array()
  throw leaving
}

/**
 * `break` or `continue` as bash 5.2 reads its count. The loops are the
 * current frame's: a function starts outside its caller's, and so does a
 * `( )` or `&` child. Outside every loop the builtin only complains; a count
 * past the loops is the loops; a count below 1 ends them all, `continue`
 * included, and fails. A word that is no number throws to the top level with
 * 128 over `$?`, and a second word abandons everything still to run.
 * Mirrors Python's leave_loops.
 */
function leaveLoops(
  name: 'break' | 'continue',
  args: readonly string[],
  session: SessionState,
  callStack: CallStack | null,
): Result {
  const loops = callStack?.current.loopLevel ?? 0
  if (loops === 0) {
    const err = builtinError(name, "only meaningful in a `for', `while', or `until' loop")
    return [null, new IOResult({ stderr: err }), new ExecutionNode({ command: name, stderr: err })]
  }
  const words = numericOperands(args)
  const first = words[0]
  if (first !== undefined && !isCountWord(first)) {
    throw new ExitSignal(
      session.lastExitCode | 128,
      builtinError(name, `${first}: numeric argument required`),
    )
  }
  if (words.length > 1) throw new ExitSignal(1, builtinError(name, 'too many arguments'))
  const count = first !== undefined ? BigInt(first.trim()) : 1n
  if (count <= 0n) {
    const err = builtinError(name, `${first ?? ''}: loop count out of range`)
    throw new BreakSignal(null, new IOResult({ exitCode: 1, stderr: err }), loops)
  }
  const Signal = name === 'break' ? BreakSignal : ContinueSignal
  throw new Signal(null, new IOResult(), count > BigInt(loops) ? loops : Number(count))
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
  return Promise.resolve(handleReturn([...call.argv.args], call.context.session, call.callStack))
}

/** The `exit` arm. */
export function exitBuiltin(call: BuiltinCall): Promise<Result> {
  return handleExit(
    [...call.argv.args],
    call.context.session,
    call.executeFn,
    call.stdin,
    call.callStack,
  )
}

/** The `break` arm: unwinds the enclosing loops by throwing. */
export function breakBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(
    leaveLoops('break', [...call.argv.args], call.context.session, call.callStack),
  )
}

/** The `continue` arm: unwinds to the next iteration by throwing. */
export function continueBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(
    leaveLoops('continue', [...call.argv.args], call.context.session, call.callStack),
  )
}
