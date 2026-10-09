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

import { VarAttr } from '../../../../shell/variable.ts'
import type { SessionState } from '../../../session/session.ts'
import { sessionView } from '../../../session/state.ts'
import type { SessionView } from '../../../../view/types.ts'
import { markNames } from './declare.ts'
import type { DeclarationOperand } from './types.ts'
import type { BuiltinCall, Result } from '../types.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'

/**
 * Export names, or print them (`export -p` / bare `export`). The exported
 * set, not every shell variable: `X=hello` is absent and `export Y=world` is
 * present, which is what bash prints. `-f` marks functions instead, for a
 * nested shell to inherit; bash accepts `-a` / `-A` although its usage line
 * names only `-fn` (`markNames`).
 */
export async function handleExport(
  assignments: readonly DeclarationOperand[],
  session: SessionState,
  state: SessionView | null = null,
  parser?: ParseScope,
): Promise<Result> {
  return markNames(assignments, session, state, VarAttr.Export, parser)
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
