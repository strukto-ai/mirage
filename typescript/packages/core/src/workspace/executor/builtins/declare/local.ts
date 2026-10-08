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
import {
  type ShellValue,
  type ShellVar,
  VarAttr,
  type VarKind,
} from '../../../../shell/variable.ts'
import { sessionEntry, type SessionState } from '../../../session/session.ts'
import {
  deref,
  envGet,
  inCallEnv,
  shadowLocal,
  visibleArrays,
  visibleAssocs,
} from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, readonlyLine, refusal, requireView } from '../shared.ts'
import {
  declarationResult,
  dropReference,
  heldValue,
  identifierRefusal,
  kindConflict,
  localAttrs,
  namerefRefusal,
  plusRefusal,
  premark,
  reachGlobal,
  scalarValue,
  stampMarks,
  startLocal,
  storeStagedArrays,
} from './declare.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { sessionView } from '../../../session/state.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * Declare names in the running function's scope, or globally.
 *
 * Each operand is declared and marked before the next one runs, as bash
 * does: `declare -r R=1 R=2` freezes `R` at 1 and refuses the second write,
 * which fails the builtin while the later operands still declare. Array
 * literals store first, and the marks land on them once every literal has
 * stored (`storeStagedArrays`).
 *
 * `cmd` is the spelling that reached here: `declare` and `typeset` route
 * through this handler and must say their own name, not `local`. `shaping`
 * holds the value-shaping attributes (`-i -l -u`), marked on each name
 * *before* its value stores so the declaration's own value coerces exactly
 * as a later write would; `marks` the attribute letters put on or taken off
 * each operand once it lands, readonly last; `plus` the `+` letters, for the
 * two that cannot be taken off (`plusRefusal`). `nameref` (`-n`) stores a
 * value on the reference's own record, which also takes the marks; under
 * `globalScope` (`-g`) a name the function shadows has its *global* record
 * read, written and marked (`reachGlobal`); `inherit` (`-I`) starts a new
 * local from the value it shadows (`startLocal`).
 */
export async function handleLocal(
  assignments: string[],
  session: SessionState,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
  cmd = 'local',
  kind: VarKind | null = null,
  shaping: ReadonlySet<VarAttr> = new Set(),
  marks: readonly (readonly [VarAttr, boolean])[] = [],
  plus = '',
  nameref = false,
  globalScope = false,
  inherit = false,
): Promise<Result> {
  if (cmd === 'local' && session.localVars === null) {
    // `local` is the one spelling that needs a function scope;
    // `declare`/`typeset` share this handler and are legal at top level.
    // Without the check the builtin took its operands, stored them
    // globally and exited 0, which is the silent-accept this whole tier
    // exists to remove.
    const err = encodeText('bash: local: can only be used in a function\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
    ]
  }
  const view = requireView(state)
  const restore = globalScope
    ? reachGlobal(session, [
        ...assignments.map((a) => a.split('=')[0] ?? a),
        ...(arrays ?? []).map(({ name }) => name),
      ])
    : null
  try {
    return await declareOperands(
      assignments,
      session,
      view,
      arrays ?? [],
      cmd,
      kind,
      shaping,
      marks,
      plus,
      nameref,
      globalScope ? null : session.localVars,
      inherit,
    )
  } finally {
    restore?.()
  }
}

/** Run `handleLocal`'s operands in the scope it settled on. */
async function declareOperands(
  assignments: readonly string[],
  session: SessionState,
  view: SessionView,
  arrays: readonly { name: string; append: boolean; items: string[] }[],
  cmd: string,
  kind: VarKind | null,
  shaping: ReadonlySet<VarAttr>,
  marks: readonly (readonly [VarAttr, boolean])[],
  plus: string,
  nameref: boolean,
  locals: Map<string, ShellVar | null> | null,
  inherit: boolean,
): Promise<Result> {
  const errors: string[] = []
  const warnings: string[] = []
  const stored: string[] = []
  try {
    const refused = await storeStagedArrays(
      cmd,
      session,
      view,
      arrays,
      errors,
      warnings,
      session.localVars === null,
      stored,
      kind,
      shaping,
      locals === null,
      inherit,
    )
    if (refused !== null) return refused
    for (const name of stored) {
      const line = plusRefusal(cmd, session, view, name, plus)
      if (line !== null) {
        errors.push(line)
        continue
      }
      await stampMarks(session, view, name, deref(session, name) || name, marks)
    }
    for (const assign of assignments) {
      const line = await declareOperand(
        session,
        view,
        assign,
        cmd,
        kind,
        shaping,
        marks,
        plus,
        nameref,
        locals,
        inherit,
      )
      if (line !== null) errors.push(line)
    }
  } catch (err) {
    if (err instanceof PolicyDenied) return refusal(cmd, err)
    if (err instanceof ArithError) return arithRefusal(cmd, err)
    throw err
  }
  return declarationResult(cmd, errors, warnings)
}

/**
 * Declare one `NAME` / `NAME=value` operand and mark it. Returns the
 * operand's refusal line, or null when it declared; a policy denial or an
 * `-i` value that does not evaluate throws.
 */
async function declareOperand(
  session: SessionState,
  view: SessionView,
  assign: string,
  cmd: string,
  kind: VarKind | null,
  shaping: ReadonlySet<VarAttr>,
  marks: readonly (readonly [VarAttr, boolean])[],
  plus: string,
  nameref: boolean,
  locals: Map<string, ShellVar | null> | null,
  inherit: boolean,
): Promise<string | null> {
  const badName = identifierRefusal(cmd, assign)
  if (badName !== null) return badName
  const eq = assign.indexOf('=')
  const key = eq >= 0 ? assign.slice(0, eq) : assign
  const fresh = locals !== null && !locals.has(key)
  if (eq < 0) {
    if (locals !== null) shadowLocal(session, locals, key)
    if (fresh) {
      const line = await freshLocal(session, view, cmd, key, inherit)
      if (line !== null) return line
    }
    const line = plusRefusal(cmd, session, view, key, plus)
    if (line !== null) return line
    if (
      envGet(session, key) === null &&
      !(key in visibleArrays(session)) &&
      !(key in visibleAssocs(session))
    ) {
      // Declared, not assigned. `local L` leaves the name *unset*, exactly
      // as `export Z` does: GNU prints `declare -- L` and `${L-d}` still
      // expands to `d`. A bare declaration of an existing array re-scopes
      // it, so nothing is written there. Visible reads: a hidden name
      // counts as unset, so the mark is attempted and the door refuses it.
      await view.mark(key, null, true, !nameref)
    }
    await stampMarks(session, view, key, null, marks, !nameref)
    return null
  }
  const val = assign.slice(eq + 1)
  if (nameref) {
    const badRef = namerefRefusal(cmd, key, val)
    if (badRef !== null) return badRef
  }
  if (view.isReadonly(key)) return readonlyLine(cmd, key)
  if (locals !== null) shadowLocal(session, locals, key)
  if (fresh && !inCallEnv(session, key)) startLocal(session, key, inherit)
  const line = plusRefusal(cmd, session, view, key, plus)
  if (line !== null) return line
  // A new local holds nothing of the caller's but what `startLocal` kept;
  // otherwise the value lands as any declaration's does (`scalarValue`),
  // and an array kind the variable cannot take is refused.
  const held = nameref || (fresh && !inherit) ? null : heldValue(session, key)
  const conflict = kindConflict(held, kind)
  if (conflict !== null) return `bash: ${cmd}: ${key}: ${conflict}`
  const [value, assigned]: [ShellValue, ReadonlySet<number | string> | null] = nameref
    ? [val, null]
    : scalarValue(held, val, kind)
  const checked = nameref ? key : deref(session, key) || key
  await premark(view, key, shaping)
  if (kind !== null && !nameref) await dropReference(session, view, key)
  await view.set(key, value, !nameref, assigned)
  await stampMarks(session, view, key, checked, marks, !nameref)
  return null
}

/**
 * Start a new bare `local NAME` unset, as bash 5.2 does.
 *
 * Only a name the frame did not shadow yet: a second `local x`, or the
 * fresh array `local -a x` has already put in place, keeps what the
 * function holds. The caller's value and attributes stay behind except
 * the export mark: GNU prints `declare -- x` for `x=1; f() { local x; }`
 * and `declare -x x` for an exported one, and `local x; x+=y` stores `y`.
 * With `-I` the value and attributes stay, a reference's aside. A name the
 * call assigned in front is the exception and keeps that value (`x=1 f`
 * where f runs `local x` reads 1). A readonly name refuses, as GNU's does,
 * and the operands after it still declare: the refusal line is returned.
 */
async function freshLocal(
  session: SessionState,
  view: SessionView,
  cmd: string,
  name: string,
  inherit = false,
): Promise<string | null> {
  const record = sessionEntry(session.vars, name)
  if (record === undefined || inCallEnv(session, name)) return null
  if (view.isReadonly(name)) return readonlyLine(cmd, name)
  if (inherit) {
    if (record.attrs.has(VarAttr.Nameref)) await view.mark(name, VarAttr.Nameref, false)
    return null
  }
  await view.unset(name, false)
  for (const attr of localAttrs(record, inherit)) await view.mark(name, attr, true)
  return null
}

/** The `local` arm. */
export async function localBuiltin(call: BuiltinCall): Promise<Result> {
  return handleLocal(
    [...call.argv.args],
    call.context.session,
    sessionView(call.context.session, call.registry.policies, call.context.frame.diagnostics),
  )
}
