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
import type { ArithWrite } from '../../../../shell/types.ts'
import { ArithError, ReadonlyError } from '../../../../shell/errors.ts'
import type { ArithResult } from '../../../../shell/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { landArith } from '../../../session/elements.ts'
import { randomReader, sessionArith } from '../../../session/state.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { readonlyRefusal, refusal, requireView } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * `(( ))` as a builtin: every operand is one expression, the writes land
 * in order, and the status is 1 when the last expression evaluated to 0.
 * No operand is `expression expected`, exit 1; a malformed one aborts
 * the builtin at that word. A write to a readonly name stops it the same
 * way, after the writes the expression made before it (`let 'X=5, R=3'`
 * leaves X at 5); one inside a subscript ends the shell.
 */
export async function handleLet(
  args: string[],
  session: SessionState,
  state: SessionView | null = null,
): Promise<Result> {
  if (args.length === 0) {
    const err = encodeText('bash: let: expression expected\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'let', exitCode: 1, stderr: err }),
    ]
  }
  const view = requireView(state)
  let value = 0n
  for (const expr of args) {
    const reader = randomReader(session)
    let error: ArithError | ReadonlyError | null = null
    let writes: readonly ArithWrite[] = []
    let expected = 0n
    try {
      const result: ArithResult = sessionArith(session, expr, reader)
      writes = result.writes
      expected = result.value
    } catch (err) {
      if (!(err instanceof ArithError || err instanceof ReadonlyError)) throw err
      // bash bound the assignments made before the error; they land
      // before the error is reported.
      error = err
      writes = err.writes
    }
    try {
      await landArith(session, view, writes)
      reader.settle()
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal('let', err)
      throw err
    }
    if (error instanceof ReadonlyError) {
      if (error.inSubscript) throw error.signal()
      return readonlyRefusal('let', error.varName)
    }
    if (error !== null) {
      const errBytes = encodeText(`bash: let: ${expr}: ${error.message}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: errBytes }),
        new ExecutionNode({ command: 'let', exitCode: 1, stderr: errBytes }),
      ]
    }
    value = expected
  }
  const code = value !== 0n ? 0 : 1
  return [
    null,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: 'let', exitCode: code }),
  ]
}

/** The `let` arm. */
export async function letBuiltin(call: BuiltinCall): Promise<Result> {
  return handleLet(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
  )
}
