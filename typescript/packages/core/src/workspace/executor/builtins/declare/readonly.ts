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
import { ArithError } from '../../../../shell/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { varHidden } from '../../../../utils/hidden.ts'
import { VarAttr, type VarKind } from '../../../../shell/variable.ts'
import { deref, outliveCall, setAttr } from '../../../session/state.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, readonlyRefusal, refusal, requireView } from '../shared.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { READONLY_FLAGS, READONLY_USAGE } from './constants.ts'
import {
  declareLine,
  declaredKind,
  heldValue,
  identifierFailure,
  identifierRefusal,
  kindConflict,
  kindListed,
  markFunctions,
  scalarValue,
  splitDeclFlags,
  storeStagedArrays,
} from './declare.ts'
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
  assignments: string[],
  session: SessionState,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
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
      arrays,
      parser,
      kind,
    )
  if (names.length === 0 && (arrays === null || arrays.length === 0)) {
    const lines = readonlyLines(session, flags)
    const out = encodeText(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
  }
  const view = requireView(state)
  const errors: string[] = []
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays(
      'readonly',
      session,
      view,
      arrays,
      VarAttr.Readonly,
      true,
      true,
      null,
      kind,
      errors,
    )
    if (refused !== null) return refused
  }
  for (const assign of names) {
    const badName = identifierRefusal('readonly', assign)
    if (badName !== null) {
      errors.push(badName)
      continue
    }
    const eq = assign.indexOf('=')
    const key = eq >= 0 ? assign.slice(0, eq) : assign
    if (eq >= 0 && view.isReadonly(key)) return readonlyRefusal('readonly', key)
    // A value of the other array kind is refused and the name is still
    // frozen, as bash does.
    const held = eq >= 0 ? heldValue(session, key) : null
    const conflict = eq >= 0 ? kindConflict(held, kind) : null
    if (conflict !== null) errors.push(`bash: readonly: ${key}: ${conflict}`)
    if (eq >= 0 && conflict === null) {
      const [value, assigned] = scalarValue(held, assign.slice(eq + 1), kind)
      try {
        await view.set(key, value, true, assigned)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('readonly', err)
        if (err instanceof ArithError) return arithRefusal('readonly', err)
        throw err
      }
      // Ungated: the `view.set` above already put this name through the
      // gate, so the mark rides on that decision.
      setAttr(session, deref(session, key) || key, VarAttr.Readonly)
    } else {
      // Gated, exactly as `export NAME` is. The bare form writes no
      // value, so it has no `view.set` to ride on, and marking through
      // `setAttr` walked straight past `preSession`: a deployment
      // refusing `AWS_*` still saw `readonly AWS_KEY` exit 0, create the
      // record, and freeze the name against every later legitimate write.
      try {
        await view.mark(key, VarAttr.Readonly, true)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('readonly', err)
        throw err
      }
    }
    outliveCall(session, key)
  }
  if (errors.length > 0) return identifierFailure('readonly', errors)
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}
