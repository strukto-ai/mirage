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
import { appended, type ShellVar, VarAttr, type VarKind } from '../../../../shell/variable.ts'
import { sessionEntry, type SessionState } from '../../../session/session.ts'
import {
  deref,
  envGet,
  evaluateInteger,
  inCallEnv,
  reachGlobal,
  shadowLocal,
  visibleArrays,
  visibleAssocs,
} from '../../../session/state.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, isValidName, readonlyLine, refusal, requireView } from '../shared.ts'
import { SUBSCRIPT_RE } from './constants.ts'
import {
  declarationResult,
  dropReference,
  heldValue,
  identifierRefusal,
  kindConflict,
  localAttrs,
  namerefRefusal,
  operandParts,
  plusRefusal,
  premark,
  referenceRefusal,
  scalarValue,
  stampMarks,
  startLocal,
  storeStagedArrays,
  visibleRecord,
} from './declare.ts'
import type { BuiltinCall, Result } from '../types.ts'
import type { AttrMarks, DeclarationOperand } from './types.ts'
import { sessionView } from '../../../session/state.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * Declare names in the running function's scope, or globally.
 *
 * bash's two passes (`storeStagedArrays`): every array literal stores
 * first, then each operand in order is declared and marked before the next
 * one runs, a literal's name at its own place. So `declare -r R=1 R=2`
 * freezes `R` at 1 and refuses the second write, which fails the builtin
 * while the later operands still declare, and `declare -r R=1 R=(2)` leaves
 * `(1)`. `assignments` holds the operands in order: `NAME`, `NAME=value`,
 * `NAME+=value` and staged array literals.
 *
 * `cmd` is the spelling that reached here: `declare` and `typeset` route
 * through this handler and must say their own name, not `local`. `shaping`
 * holds the value-shaping marks (`-i -l -u`, `+i +l +u`), put on or taken
 * off each name *before* its value stores so the declaration's own value
 * coerces exactly as a later write would (`declare +i N+=x` over an integer
 * 5 stores `5x`); `marks` the attribute letters put on or taken off
 * each operand once it lands, readonly last; `plus` the `+` letters, for the
 * two that cannot be taken off (`plusRefusal`). `nameref` (`-n`) stores a
 * value on the reference's own record, which also takes the marks; under
 * `globalScope` (`-g`) a name the function shadows has its *global* record
 * read, written and marked (`reachGlobal`); `inherit` (`-I`) starts a new
 * local from the value it shadows (`startLocal`).
 */
export async function handleLocal(
  assignments: readonly DeclarationOperand[],
  session: SessionState,
  state: SessionView | null = null,
  cmd = 'local',
  kind: VarKind | null = null,
  shaping: AttrMarks = [],
  marks: AttrMarks = [],
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
    ? reachGlobal(
        session,
        assignments.map((a) => (typeof a === 'string' ? operandParts(a)[0] : a.name)),
      )
    : null
  try {
    return await declareOperands(
      assignments,
      session,
      view,
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
  operands: readonly DeclarationOperand[],
  session: SessionState,
  view: SessionView,
  cmd: string,
  kind: VarKind | null,
  shaping: AttrMarks,
  marks: AttrMarks,
  plus: string,
  nameref: boolean,
  locals: Map<string, ShellVar | null> | null,
  inherit: boolean,
): Promise<Result> {
  const errors: string[] = []
  const warnings: string[] = []
  const stored = new Map<number, string>()
  try {
    const refused = await storeStagedArrays(
      cmd,
      session,
      view,
      operands,
      errors,
      warnings,
      session.localVars === null,
      stored,
      kind,
      shaping,
      locals === null,
      inherit,
    )
    for (const [position, operand] of operands.entries()) {
      let line: string | null
      if (typeof operand === 'string') {
        line =
          refused !== null
            ? null
            : await declareOperand(
                session,
                view,
                operand,
                cmd,
                kind,
                shaping,
                marks,
                plus,
                nameref,
                locals,
                inherit,
              )
      } else {
        // A literal takes its marks at its place, against the target its
        // own write cleared, even when a policy refused a later literal;
        // under `-n` they go on the reference, which an array cannot
        // become and a frozen one refuses, its own `-i -l -u` coming off
        // unless asked for (`unshaped`).
        const checked = stored.get(position)
        if (checked === undefined) continue
        const name = operand.name
        line =
          (nameref ? literalReferenceRefusal(session, view, cmd, name) : null) ??
          plusRefusal(cmd, session, view, name, plus)
        if (line === null) {
          await stampMarks(
            session,
            view,
            name,
            checked,
            nameref ? unshaped(marks) : marks,
            !nameref,
          )
        }
      }
      if (line !== null) errors.push(line)
    }
    if (refused !== null) return refused
  } catch (err) {
    if (err instanceof PolicyDenied) return refusal(cmd, err)
    if (err instanceof ArithError) return arithRefusal(cmd, err)
    throw err
  }
  return declarationResult(cmd, errors, warnings)
}

/**
 * The line a `-n` array literal earns on the reference it was written
 * through: an array cannot become one, and a frozen one keeps every mark
 * (`declare -nr r=t; declare -n r=(3)` writes `t` and refuses `r`), as
 * bash's does.
 */
function literalReferenceRefusal(
  session: SessionState,
  view: SessionView,
  cmd: string,
  name: string,
): string | null {
  const line = referenceRefusal(cmd, name, visibleRecord(session, name), false)
  if (line === null && view.isReadonly(name, false)) return readonlyLine(cmd, name)
  return line
}

/**
 * Declare one `NAME`, `NAME=value` or `NAME+=value` operand and mark it.
 * Returns the operand's refusal line, or null when it declared; a policy
 * denial or an `-i` value that does not evaluate throws. A `-n`
 * declaration writes the reference itself, so a frozen reference refuses
 * it (`declare -rn r=T; declare -n r=U`) even when what it points at is
 * writable.
 */
async function declareOperand(
  session: SessionState,
  view: SessionView,
  assign: string,
  cmd: string,
  kind: VarKind | null,
  shaping: AttrMarks,
  marks: AttrMarks,
  plus: string,
  nameref: boolean,
  locals: Map<string, ShellVar | null> | null,
  inherit: boolean,
): Promise<string | null> {
  const badName = identifierRefusal(cmd, assign)
  if (badName !== null) return badName
  const [key, append, given] = operandParts(assign)
  const fresh = locals !== null && !locals.has(key)
  if (nameref) {
    // The reference's own `-i -l -u` come off unless asked for, as bash's
    // do (`declare -l x=T; declare -n x=U` aims at `U`); its target's stay.
    shaping = unshaped(shaping)
    marks = unshaped(marks)
  }
  if (given === null) {
    if (locals !== null) shadowLocal(session, locals, key)
    if (fresh) {
      const line = await freshLocal(session, view, cmd, key, inherit)
      if (line !== null) return line
    }
    if (nameref) {
      const bad =
        referenceRefusal(cmd, key, visibleRecord(session, key), true) ??
        (view.isReadonly(key, false) ? readonlyLine(cmd, key) : null)
      if (bad !== null) return bad
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
  if (nameref && !append && given !== '') {
    // A value that names no variable refuses first, before a local is made;
    // an empty one, and what `+=` builds, are judged once the name may take
    // a reference (`aimReference`).
    const badRef = namerefRefusal(cmd, key, given)
    if (badRef !== null) return badRef
  }
  const creates = fresh && !inCallEnv(session, key)
  if ((creates || !nameref) && view.isReadonly(key, !nameref)) return readonlyLine(cmd, key)
  if (locals !== null) shadowLocal(session, locals, key)
  if (creates) startLocal(session, key, inherit)
  if (nameref) {
    // Checked on the local, which exists from here on even when the array
    // it inherited cannot become a reference, as bash's does, so the
    // function's later writes stay its own. A name no local replaces
    // reports its array before its readonly mark.
    const badRef =
      referenceRefusal(cmd, key, visibleRecord(session, key), false) ??
      (view.isReadonly(key, false) ? readonlyLine(cmd, key) : null)
    if (badRef !== null) return badRef
  }
  const line = plusRefusal(cmd, session, view, key, plus)
  if (line !== null) return line
  if (nameref) {
    return aimReference(session, view, cmd, key, append, given, shaping, marks, creates)
  }
  // A new local holds nothing of the caller's but what `startLocal` kept;
  // otherwise the value lands as any declaration's does (`scalarValue`),
  // and an array kind the variable cannot take is refused.
  const held = fresh && !inherit ? null : heldValue(session, key)
  const conflict = kindConflict(held, kind)
  if (conflict !== null) return `bash: ${cmd}: ${key}: ${conflict}`
  const checked = deref(session, key) || key
  await premark(view, key, shaping)
  const integer = sessionEntry(session.vars, checked)?.attrs.has(VarAttr.Integer) === true
  const [value, assigned] = scalarValue(held, given, kind, append, integer)
  if (kind !== null) await dropReference(session, view, key)
  await view.set(key, value, true, assigned)
  await stampMarks(session, view, key, checked, marks)
  return null
}

/** `marks` taking off each of `-i -l -u` they do not name. */
function unshaped(marks: AttrMarks): AttrMarks {
  const named = new Set(marks.map(([attr]) => attr))
  const off = [VarAttr.Integer, VarAttr.Lower, VarAttr.Upper]
    .filter((attr) => !named.has(attr))
    .map((attr) => [attr, false] as const)
  return [...off, ...marks]
}

/**
 * Aim a `declare -n NAME=VALUE` (or `NAME+=VALUE`) reference once the name
 * may take one.
 *
 * The reference is what `+=` builds onto its own value, and under a
 * declared `-i` what the arithmetic makes of it, landing the writes it does
 * (`M='X=5'; declare -ni r=M` sets X) and never a name. A result that names
 * no variable fails, in bash's words when the given text names none either
 * (`declare -n r=''` is `` `': not a valid identifier``) and silently
 * otherwise (`x=1; declare -n x+=T`). The name still takes the
 * declaration's marks but `-n`, `-i -l -u` it did not ask for coming off,
 * and a local it made stays declared; a name that never existed stays
 * unset. Returns the refusal line ('' for a silent one), or null once aimed.
 */
async function aimReference(
  session: SessionState,
  view: SessionView,
  cmd: string,
  key: string,
  append: boolean,
  given: string,
  shaping: AttrMarks,
  marks: AttrMarks,
  creates: boolean,
): Promise<string | null> {
  const held = append ? visibleRecord(session, key)?.value : undefined
  const old = typeof held === 'string' ? held : ''
  let value = old + given
  if (shaping.some(([attr, on]) => attr === VarAttr.Integer && on)) {
    await evaluateInteger(session, view, append ? appended(old, given, true) : given)
    value = ''
  }
  if (isValidName(value) || SUBSCRIPT_RE.test(value)) {
    const line = namerefRefusal(cmd, key, value)
    if (line !== null) return line
    await premark(view, key, shaping, false)
    await view.set(key, value, false, null)
    await stampMarks(session, view, key, key, marks, false)
    return null
  }
  if (creates && sessionEntry(session.vars, key) === undefined) {
    await view.mark(key, null, true, false)
  }
  if (sessionEntry(session.vars, key) !== undefined) {
    const kept = marks.filter(([attr]) => attr !== VarAttr.Nameref)
    await stampMarks(session, view, key, null, kept, false)
  }
  return isValidName(given) ? '' : `bash: ${cmd}: \`${given}': not a valid identifier`
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
