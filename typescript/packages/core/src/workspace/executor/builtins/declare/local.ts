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
import type { VarAttr } from '../../../../shell/variable.ts'
import type { Session } from '../../../session/session.ts'
import { envGet, shadowLocal, visibleArrays, visibleAssocs } from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, readonlyRefusal, refusal, requireView } from '../shared.ts'
import {
  identifierFailure,
  identifierRefusal,
  namerefRefusal,
  premark,
  storeStagedArrays,
  writeGlobal,
} from './declare.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'

export async function handleLocal(
  assignments: string[],
  session: Session,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
  cmd = 'local',
  stored: string[] | null = null,
  assoc = false,
  shaping: ReadonlySet<VarAttr> = new Set(),
  nameref = false,
  globalScope = false,
): Promise<Result> {
  const locals = globalScope ? null : session.localVars
  if (cmd === 'local' && session.localVars === null) {
    // `local` is the one spelling that needs a function scope;
    // `declare`/`typeset` share this handler and are legal at top level.
    // Without the check the builtin took its operands, stored them
    // globally and exited 0, which is the silent-accept this whole tier
    // exists to remove.
    const err = new TextEncoder().encode('bash: local: can only be used in a function\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
    ]
  }
  const view = requireView(state)
  const errors: string[] = []
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays(
      cmd,
      session,
      view,
      arrays,
      null,
      true,
      locals === null,
      stored,
      assoc,
      errors,
      shaping,
      globalScope,
    )
    if (refused !== null) return refused
  }
  for (const assign of assignments) {
    const badName = identifierRefusal(cmd, assign)
    if (badName !== null) {
      errors.push(badName)
      continue
    }
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      const val = assign.slice(eq + 1)
      if (nameref) {
        const badRef = namerefRefusal(cmd, key, val)
        if (badRef !== null) {
          errors.push(badRef)
          continue
        }
      }
      if (view.isReadonly(key)) return readonlyRefusal(cmd, key)
      if (locals !== null) shadowLocal(session, locals, key)
      try {
        await premark(view, key, shaping)
        if (globalScope) await writeGlobal(session, view, key, val)
        else await view.set(key, val, !nameref)
      } catch (err) {
        if (err instanceof PolicyDenied) return refusal(cmd, err)
        if (err instanceof ArithError) return arithRefusal(cmd, err)
        throw err
      }
      if (stored !== null) stored.push(key)
    } else {
      if (locals !== null) shadowLocal(session, locals, assign)
      if (
        envGet(session, assign) === null &&
        !(assign in visibleArrays(session)) &&
        !(assign in visibleAssocs(session))
      ) {
        // A bare declaration of an existing array re-scopes it; a
        // scalar write here would erase it. Visible reads: a hidden
        // name counts as unset, so the write is attempted and the
        // door refuses it.
        if (view.isReadonly(assign)) return readonlyRefusal(cmd, assign)
        try {
          // Declared, not assigned. `local L` leaves the name *unset*,
          // exactly as `export Z` does: GNU prints `declare -- L` and
          // `${L-d}` still expands to `d`. Writing `''` here made both
          // wrong, which is the same invented-empty-string bug the mark
          // door was added to fix for `export`.
          await view.mark(assign, null, true)
        } catch (err) {
          if (err instanceof PolicyDenied) return refusal(cmd, err)
          throw err
        }
      }
      if (stored !== null) stored.push(assign)
    }
  }
  if (errors.length > 0) return identifierFailure(cmd, errors)
  return [null, new IOResult(), new ExecutionNode({ command: cmd, exitCode: 0 })]
}

/** The `local` arm. */
export async function localBuiltin(call: BuiltinCall): Promise<Result> {
  return handleLocal(
    [...call.argv.args],
    call.session,
    sessionView(call.session, call.registry.policies),
  )
}
