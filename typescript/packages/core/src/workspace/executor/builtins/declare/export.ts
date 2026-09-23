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
import { setAttr } from '../../../session/state.ts'
import type { SessionState } from '../../../session/session.ts'
import { exportedNames } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { readonlyRefusal, refusal, requireView } from '../shared.ts'
import { EXPORT_FLAGS, EXPORT_USAGE } from './constants.ts'
import {
  declareLine,
  identifierFailure,
  identifierRefusal,
  splitDeclFlags,
  storeStagedArrays,
} from './declare.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'

function exportLines(session: SessionState, flags: Set<string>): string[] {
  // The exported set, not every shell variable: `X=hello` is absent and
  // `export Y=world` is present, which is what bash prints. -f selects
  // shell functions; mirage tracks no export attribute on functions, so
  // that form lists nothing, as bash does with none exported.
  //
  // Rendering is `declareLine`'s, not a second spelling of it: GNU's
  // `export -p` prints the *whole* cluster, so a readonly exported
  // scalar is `declare -rx R="1"` and an exported array is
  // `declare -ax AR=([0]="a")`. Writing `declare -x` here by hand
  // printed neither, and rendered an exported array as a bare
  // `declare -x AR` because it looked the value up among the scalars.
  if (flags.has('f')) return []
  return exportedNames(session)
    .map((name) => declareLine(session, name))
    .filter((line): line is string => line !== null)
}

export async function handleExport(
  assignments: string[],
  session: SessionState,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
): Promise<Result> {
  const { flags, names, bad } = splitDeclFlags(assignments, EXPORT_FLAGS)
  if (bad !== null) {
    const err = new TextEncoder().encode(`bash: export: -${bad}: invalid option\n${EXPORT_USAGE}`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'export', exitCode: 2, stderr: err }),
    ]
  }
  if (names.length === 0 && (arrays === null || arrays.length === 0)) {
    const lines = exportLines(session, flags)
    const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
  }
  // -f is accepted and marks nothing: mirage carries no export attribute
  // on functions. -n is the off direction, and applies to both spellings,
  // since `export -n K=v` assigns and unexports.
  const view = requireView(state)
  const on = !flags.has('n')
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
    )
    if (refused !== null) return refused
  }
  const errors: string[] = []
  for (const assign of names) {
    const badName = identifierRefusal('export', assign)
    if (badName !== null) {
      errors.push(badName)
      continue
    }
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (view.isReadonly(key)) return readonlyRefusal('export', key)
      try {
        await view.set(key, assign.slice(eq + 1))
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('export', err)
        throw err
      }
      setAttr(session, key, VarAttr.Export, on)
    } else {
      // The bare form writes no value, so it marks through the plane's
      // no-value door rather than inventing an empty string. On a name
      // that does not exist yet that leaves it *unset and exported*,
      // which is bash's own third state -- `export Z` prints
      // `declare -x Z` and stays out of `env` until something gives it a
      // value. Still gated: marking a hidden or policy-refused name is a
      // session write.
      try {
        await view.mark(assign, VarAttr.Export, on)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal('export', err)
        throw err
      }
    }
  }
  if (errors.length > 0) return identifierFailure('export', errors)
  return [null, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
}

/** The `export` arm. */
export async function exportBuiltin(call: BuiltinCall): Promise<Result> {
  return handleExport(
    [...call.argv.args],
    call.session,
    sessionView(call.session, call.registry.policies),
  )
}
