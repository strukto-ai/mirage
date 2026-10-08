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
import { PolicyDenied } from '../../../../policy/errors.ts'
import { VarAttr } from '../../../../shell/variable.ts'
import { deref, outliveCall, setAttr } from '../../../session/state.ts'
import type { SessionState } from '../../../session/session.ts'
import { exportedNames } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { readonlyRefusal, refusal, requireView } from '../shared.ts'
import { EXPORT_FLAGS, EXPORT_USAGE } from './constants.ts'
import {
  declaredKind,
  heldValue,
  declareLine,
  identifierFailure,
  identifierRefusal,
  kindConflict,
  kindListed,
  markFunctions,
  scalarValue,
  splitDeclFlags,
  storeStagedArrays,
} from './declare.ts'
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
  assignments: string[],
  session: SessionState,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
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
      arrays,
      parser,
      kind,
    )
  if (names.length === 0 && (arrays === null || arrays.length === 0)) {
    const lines = exportLines(session, flags)
    const out = encodeText(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
  }
  const view = requireView(state)
  const errors: string[] = []
  if (arrays !== null && arrays.length > 0) {
    // `export ARR=(a b)` marks the array as surely as it marks a scalar:
    // GNU prints `declare -ax ARR=([0]="a" [1]="b")`.
    const refused = await storeStagedArrays(
      'export',
      session,
      view,
      arrays,
      VarAttr.Export,
      on,
      true,
      null,
      kind,
    )
    if (refused !== null) return refused
  }
  for (const assign of names) {
    const badName = identifierRefusal('export', assign)
    if (badName !== null) {
      errors.push(badName)
      continue
    }
    const eq = assign.indexOf('=')
    const key = eq >= 0 ? assign.slice(0, eq) : assign
    if (eq >= 0 && view.isReadonly(key)) return readonlyRefusal('export', key)
    // A value of the other array kind is refused and the name is still
    // marked, as bash does.
    const held = eq >= 0 ? heldValue(session, key) : null
    const conflict = eq >= 0 ? kindConflict(held, kind) : null
    if (conflict !== null) errors.push(`bash: export: ${key}: ${conflict}`)
    if (eq >= 0 && conflict === null) {
      const [value, assigned] = scalarValue(held, assign.slice(eq + 1), kind)
      try {
        await view.set(key, value, true, assigned)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('export', err)
        throw err
      }
      setAttr(session, deref(session, key) || key, VarAttr.Export, on)
    } else {
      // The bare form writes no value, so it marks through the plane's
      // no-value door rather than inventing an empty string. On a name
      // that does not exist yet that leaves it *unset and exported*,
      // which is bash's own third state -- `export Z` prints
      // `declare -x Z` and stays out of `env` until something gives it a
      // value. Still gated: marking a hidden or policy-refused name is a
      // session write.
      try {
        await view.mark(key, VarAttr.Export, on)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('export', err)
        throw err
      }
    }
    if (on) outliveCall(session, key)
  }
  if (errors.length > 0) return identifierFailure('export', errors)
  return [null, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
}

/** The `export` arm. */
export async function exportBuiltin(call: BuiltinCall): Promise<Result> {
  return handleExport(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
    null,
    call.parser,
  )
}
