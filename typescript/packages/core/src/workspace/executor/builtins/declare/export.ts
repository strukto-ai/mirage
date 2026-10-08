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
import { VarAttr } from '../../../../shell/variable.ts'
import type { SessionState } from '../../../session/session.ts'
import { exportedNames } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { requireView } from '../shared.ts'
import { EXPORT_FLAGS, EXPORT_USAGE } from './constants.ts'
import {
  declaredKind,
  declareLine,
  kindListed,
  markFunctions,
  markVariables,
  splitDeclFlags,
} from './declare.ts'
import type { DeclarationOperand } from './types.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'

function exportLines(session: SessionState, flags: ReadonlySet<string>): string[] {
  // The exported set, not every shell variable: `X=hello` is absent and
  // `export Y=world` is present, which is what bash prints. -a / -A narrow
  // it to exported indexed / associative arrays (`kindListed`).
  //
  // Rendering is `declareLine`'s, not a second spelling of it: GNU's
  // `export -p` prints the *whole* cluster, so a readonly exported
  // scalar is `declare -rx R="1"` and an exported array is
  // `declare -ax AR=([0]="a")`. Writing `declare -x` here by hand
  // printed neither, and rendered an exported array as a bare
  // `declare -x AR` because it looked the value up among the scalars.
  return exportedNames(session)
    .filter((name) => kindListed(session, name, flags))
    .map((name) => declareLine(session, name))
    .filter((line): line is string => line !== null)
}

/**
 * Export names, or print them (`export -p` / bare `export`). `-f` marks
 * functions instead, for a nested shell to inherit (`markFunctions`). `-a` /
 * `-A` shape only an assigned value, as `readonly`'s do; bash accepts them
 * although its usage line names only `-fn`.
 */
export async function handleExport(
  assignments: readonly DeclarationOperand[],
  session: SessionState,
  state: SessionView | null = null,
  parser?: ParseScope,
): Promise<Result> {
  const { flags, names, bad } = splitDeclFlags(assignments, EXPORT_FLAGS)
  if (bad !== null) {
    const err = encodeText(`bash: export: -${bad}: invalid option\n${EXPORT_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'export', exitCode: 2, stderr: err }),
    ]
  }
  // -n is the off direction, and applies to every spelling, since
  // `export -n K=v` assigns and unexports.
  const on = !flags.has('n')
  const kind = declaredKind(flags)
  if (flags.has('f'))
    return markFunctions(
      'export',
      session,
      session.exportedFunctions,
      names,
      on,
      state,
      parser,
      kind,
    )
  if (names.length === 0) {
    const lines = exportLines(session, flags)
    const out = encodeText(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
  }
  // `export ARR=(a b)` marks the array as surely as it marks a scalar:
  // GNU prints `declare -ax ARR=([0]="a" [1]="b")`.
  return markVariables('export', session, requireView(state), names, VarAttr.Export, on, kind)
}

/** The `export` arm. */
export async function exportBuiltin(call: BuiltinCall): Promise<Result> {
  return handleExport(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
    call.parser,
  )
}
