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

import { ArithError, ReadonlyError } from '../../../../shell/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { landedArith } from '../../../session/elements.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../view/types.ts'
import { fail, readonlyRefusal, refusal, requireView, result } from '../shared.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'

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
  if (args.length === 0) return fail('let', 'bash: let: expression expected\n')
  const view = requireView(state)
  let value = 0n
  for (const expr of args) {
    try {
      value = await landedArith(session, view, expr)
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal('let', err)
      if (!(err instanceof ArithError || err instanceof ReadonlyError)) throw err
      if (err.inSubscript) throw err.signal()
      if (err instanceof ReadonlyError) return readonlyRefusal('let', err.varName)
      return fail('let', `bash: let: ${err.message}\n`)
    }
  }
  return result('let', { exitCode: value !== 0n ? 0 : 1 })
}

/** The `let` arm. */
export async function letBuiltin(call: BuiltinCall): Promise<Result> {
  return handleLet(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
  )
}
