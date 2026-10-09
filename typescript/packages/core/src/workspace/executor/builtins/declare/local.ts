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

import { ArithError } from '../../../../shell/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { type ShellVar, VarAttr } from '../../../../shell/variable.ts'
import { sessionEntry, type SessionState } from '../../../session/session.ts'
import {
  appended,
  deref,
  envGet,
  evaluateInteger,
  inCallEnv,
  reachGlobal,
  sessionView,
  shadowLocal,
  visibleArrays,
  visibleAssocs,
} from '../../../session/state.ts'
import type { SessionView } from '../../../../view/types.ts'
import { fail, isValidName, readonlyLine, refusal, requireView } from '../shared.ts'
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
import type { AttrMarks, Declaration, DeclarationOperand } from './types.ts'

/**
 * Declare names in the running function's scope, or globally.
 *
 * bash's two passes (`storeStagedArrays`): every array literal stores
 * first, then each operand in order is declared and marked before the next
 * one runs, a literal's name at its own place. So `declare -r R=1 R=2`
 * freezes `R` at 1 and refuses the second write, which fails the builtin
 * while the later operands still declare, and `declare -r R=1 R=(2)` leaves
 * `(1)`. `assignments` holds the operands in order: `NAME`, `NAME=value`,
 * `NAME+=value` and staged array literals; `options` the spelling and the
 * letters it carried, `local` with none by default.
 */
export async function handleLocal(
  assignments: readonly DeclarationOperand[],
  session: SessionState,
  state: SessionView | null = null,
  options: Partial<Declaration> = {},
): Promise<Result> {
  const decl: Declaration = {
    cmd: 'local',
    kind: null,
    shaping: [],
    marks: [],
    plus: '',
    nameref: false,
    globalScope: false,
    inherit: false,
    ...options,
  }
  if (decl.cmd === 'local' && session.localVars === null) {
    // `local` is the one spelling that needs a function scope;
    // `declare`/`typeset` share this handler and are legal at top level.
    // Without the check the builtin took its operands, stored them
    // globally and exited 0, which is the silent-accept this whole tier
    // exists to remove.
    return fail('local', 'bash: local: can only be used in a function\n')
  }
  const view = requireView(state)
  const restore = decl.globalScope
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
      decl,
      decl.globalScope ? null : session.localVars,
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
  decl: Declaration,
  locals: Map<string, ShellVar | null> | null,
): Promise<Result> {
  const { cmd, kind, shaping, marks, plus, nameref, inherit } = decl
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
        line = refused !== null ? null : await declareOperand(session, view, operand, decl, locals)
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
          (nameref ? referenceLine(session, view, cmd, name, false) : null) ??
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
    if (err instanceof ArithError) throw err.signal(cmd, true)
    throw err
  }
  return declarationResult(cmd, errors, warnings)
}

/**
 * The line a `-n` operand earns on the name it lands on: an array cannot
 * become a reference (`referenceRefusal`), and a frozen one keeps every mark
 * (`declare -nr r=t; declare -n r=(3)` writes `t` and refuses `r`), as
 * bash's does. `bare` is an operand that gave no value.
 */
function referenceLine(
  session: SessionState,
  view: SessionView,
  cmd: string,
  name: string,
  bare: boolean,
): string | null {
  const line = referenceRefusal(cmd, name, visibleRecord(session, name), bare)
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
  decl: Declaration,
  locals: Map<string, ShellVar | null> | null,
): Promise<string | null> {
  const { cmd, kind, plus, nameref, inherit } = decl
  // The reference's own `-i -l -u` come off unless asked for, as bash's do
  // (`declare -l x=T; declare -n x=U` aims at `U`); its target's stay.
  const shaping = nameref ? unshaped(decl.shaping) : decl.shaping
  const marks = nameref ? unshaped(decl.marks) : decl.marks
  const badName = identifierRefusal(cmd, assign)
  if (badName !== null) return badName
  const [key, append, given] = operandParts(assign)
  const fresh = locals !== null && !locals.has(key)
  if (given === null) {
    if (locals !== null) shadowLocal(session, locals, key)
    if (fresh) {
      const line = await freshLocal(session, view, cmd, key, inherit)
      if (line !== null) return line
    }
    const line =
      (nameref ? referenceLine(session, view, cmd, key, true) : null) ??
      plusRefusal(cmd, session, view, key, plus)
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
      // counts as unset, so the mark is attempted and the session view refuses it.
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
  // A reference is checked on the local, which exists from here on even
  // when the array it inherited cannot become a reference, as bash's does,
  // so the function's later writes stay its own. A name no local replaces
  // reports its array before its readonly mark.
  const line =
    (nameref ? referenceLine(session, view, cmd, key, false) : null) ??
    plusRefusal(cmd, session, view, key, plus)
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
  const [slot, added] = append ? appended(held, given, integer) : [given, null]
  const [value, assigned] = scalarValue(held, slot, kind)
  if (kind !== null) await dropReference(session, view, key)
  await view.set(key, value, true, assigned, added)
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
    await evaluateInteger(session, view, append ? old : given, append ? given : null)
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
  inherit: boolean,
): Promise<string | null> {
  const record = sessionEntry(session.vars, name)
  if (record === undefined || inCallEnv(session, name)) return null
  if (view.isReadonly(name)) return readonlyLine(cmd, name)
  if (inherit) {
    if (record.attrs.has(VarAttr.Nameref)) await view.mark(name, VarAttr.Nameref, false)
    return null
  }
  await view.unset(name, false)
  for (const attr of localAttrs(record, false)) await view.mark(name, attr, true)
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
