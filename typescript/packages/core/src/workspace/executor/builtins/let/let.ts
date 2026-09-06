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
import { ArithError } from '../../../../shell/errors.ts'
import { evaluateArith } from '../../../../shell/arith.ts'
import type { ArithResult } from '../../../../shell/types.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { assignElement } from '../../../session/elements.ts'
import { ensureVarVisible, randomReader, sessionElements } from '../../../session/state.ts'
import type { Session } from '../../../session/session.ts'
import { visibleEnv } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { readonlyRefusal, refusal, requireView } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'

/**
 * `(( ))` as a builtin: every operand is one expression, the writes land
 * in order, and the status is 1 when the last expression evaluated to 0.
 * No operand is `expression expected`, exit 1; a malformed one aborts
 * the builtin at that word.
 */
export async function handleLet(
  args: string[],
  session: Session,
  state: SessionView | null = null,
): Promise<Result> {
  if (args.length === 0) {
    const err = new TextEncoder().encode('bash: let: expression expected\n')
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
    let error: ArithError | null = null
    let writes: readonly ArithWrite[] = []
    let expected = 0n
    try {
      const result: ArithResult = evaluateArith(
        expr,
        visibleEnv(session),
        0,
        sessionElements(session, reader),
        reader.read,
        reader.wrote,
      )
      writes = result.writes
      expected = result.value
    } catch (err) {
      if (!(err instanceof ArithError)) throw err
      // bash bound the assignments made before the error; they land
      // before the error is reported.
      error = err
      writes = err.writes
    }
    for (const write of writes) {
      try {
        ensureVarVisible(session, write.name)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('let', err)
        throw err
      }
      if (view.isReadonly(write.name)) return readonlyRefusal('let', write.name)
    }
    try {
      for (const write of writes) {
        await assignElement(session, view, write.name, write.key, write.value)
      }
      reader.settle()
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal('let', err)
      throw err
    }
    if (error !== null) {
      const errBytes = new TextEncoder().encode(`bash: let: ${expr}: ${error.message}\n`)
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
    call.session,
    sessionView(call.session, call.registry.policies),
  )
}
