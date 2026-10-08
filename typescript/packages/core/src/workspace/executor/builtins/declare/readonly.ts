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
import { varHidden } from '../../../../utils/hidden.ts'
import { VarAttr, type VarKind } from '../../../../shell/variable.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../doors/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { requireView } from '../shared.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { READONLY_FLAGS, READONLY_USAGE } from './constants.ts'
import {
  declaredKind,
  declareLine,
  kindListed,
  markFunctions,
  markVariables,
  splitDeclFlags,
} from './declare.ts'
import type { DeclarationOperand } from './types.ts'
import type { Result } from '../types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'

function readonlyLines(session: SessionState, flags: Set<string>): string[] {
  // Each name's `declare -p` line, so the whole cluster prints (`declare
  // -ir`, `declare -arx`) as bash's does; -a narrows to indexed arrays and
  // -A to associative ones (`kindListed`). A hidden readonly never prints
  // even its bare `declare -r NAME` row.
  return [...session.readonlyVars]
    .filter((name) => !varHidden(session.visibility, name) && kindListed(session, name, flags))
    .sort(compareCodePoints)
    .map((name) => declareLine(session, name))
    .filter((line): line is string => line !== null)
}

/**
 * Mark names readonly, or print them (`readonly -p` / bare `readonly`).
 *
 * With no name operands, prints every readonly name as `declare -p` does.
 * Invalid options fail with status 2. `-a` / `-A` shape only an assigned
 * value (`scalarValue`, `storeStagedArrays`): a bare `readonly -a NAME`
 * marks the name and converts nothing. `-f` freezes functions instead, or
 * lists the frozen (`markFunctions`).
 */
export async function handleReadonly(
  assignments: readonly DeclarationOperand[],
  session: SessionState,
  state: SessionView | null = null,
  kind: VarKind | null = null,
  parser?: ParseScope,
): Promise<Result> {
  const { flags, names, bad } = splitDeclFlags(assignments, READONLY_FLAGS)
  if (bad !== null) {
    const err = encodeText(`bash: readonly: -${bad}: invalid option\n${READONLY_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'readonly', exitCode: 2, stderr: err }),
    ]
  }
  kind ??= declaredKind(flags)
  if (flags.has('f'))
    return markFunctions(
      'readonly',
      session,
      session.readonlyFunctions,
      names,
      true,
      state,
      parser,
      kind,
    )
  if (names.length === 0) {
    const lines = readonlyLines(session, flags)
    const out = encodeText(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
  }
  return markVariables('readonly', session, requireView(state), names, VarAttr.Readonly, true, kind)
}
