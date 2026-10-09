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

import { storedFunctionText } from '../../../../shell/printer.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'
import { IOResult } from '../../../../io/types.ts'
import { ArithError, DiscardSignal } from '../../../../shell/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import {
  arrayGet,
  arraySet,
  buildAssocLiteral,
  buildIndexedLiteral,
  type ShellArray,
} from '../../../../shell/array.ts'
import { varHidden } from '../../../../utils/hidden.ts'
import { sessionEntry, setSessionEntry } from '../../../session/session.ts'
import type { ShellValue, ShellVar } from '../../../../shell/variable.ts'
import { appended, attrLetters, VarAttr, VarKind } from '../../../../shell/variable.ts'
import {
  conversionScalar,
  deref,
  inCallEnv,
  outliveCall,
  setAttr,
  shadowLocal,
  subscriptIndex,
} from '../../../session/state.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../view/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { isValidName, readonlyLine, refusal, requireView } from '../shared.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import {
  ANSI_C_ESCAPES,
  BARE_KEY_RE,
  CONTROL_RE,
  LISTED_ATTRIBUTES,
  SUBSCRIPT_RE,
  VISIBLE_SCOPE_BUILTINS,
} from './constants.ts'
import type { Result } from '../types.ts'
import type { AttrMarks, DeclarationOperand } from './types.ts'
import { encodeText } from '../../../../shell/bytes.ts'

/**
 * Put a declaration's value-shaping marks on a name before its value
 * stores. The session view coerces on write by reading the record's attributes, so
 * for the declaration's *own* value to coerce (`declare -i n=3+4` stores
 * `7`), the attribute has to be there first; a `+` letter comes off first
 * too, so `declare -i N=5; declare +i N+=x` stores `5x`. Gated like every
 * other mark, and a no-op with nothing to shape. `followRef` is the write's:
 * a `-n` declaration shapes the reference itself.
 */
export async function premark(
  view: SessionView,
  name: string,
  shaping: AttrMarks,
  followRef = true,
): Promise<void> {
  for (const [attr, on] of shaping) await view.mark(name, attr, on, followRef)
}

/**
 * The array kind a declaration's `-a` / `-A` asks for, `-A` winning when both
 * are given (bash's `export -aA B=(1)` builds a map), or null for neither.
 */
export function declaredKind(flags: ReadonlySet<string>): VarKind | null {
  if (flags.has('A')) return VarKind.Assoc
  if (flags.has('a')) return VarKind.Indexed
  return null
}

/**
 * The value a declaration's `NAME=...` lands on: the variable a `declare -n`
 * reference names.
 */
export function heldValue(session: SessionState, name: string): ShellValue | null {
  return sessionEntry(session.vars, deref(session, name) || name)?.value ?? null
}

/**
 * The attributes a new local takes from the variable it shadows: the export
 * mark alone (`local I=2+3` over `declare -i I` stores `2+3`), or with `-I`
 * every one but a reference, as bash's `local -I` keeps `-i` and drops `-n`.
 */
export function localAttrs(v: ShellVar | undefined, inherit: boolean): Set<VarAttr> {
  if (v === undefined) return new Set()
  if (inherit) return new Set([...v.attrs].filter((a) => a !== VarAttr.Nameref))
  return new Set([...v.attrs].filter((a) => a === VarAttr.Export))
}

/**
 * Reset a name the running function just shadowed to what a new local starts
 * as: unset, with the attributes `localAttrs` keeps, or under `-I` the
 * shadowed value too, so `local -I A=new` over `A=(old keep)` writes element
 * 0 of `(old keep)`. This is the scope's own bookkeeping, not a session
 * write: the caller's record is the frame's to put back on return, so no
 * policy is asked to delete it. The local's value lands later through the
 * gated session view, which judges that write.
 */
export function startLocal(session: SessionState, name: string, inherit: boolean): void {
  const v = sessionEntry(session.vars, name)
  const kept = localAttrs(v, inherit)
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.vars[name]
  if (v !== undefined && (kept.size > 0 || inherit)) {
    setSessionEntry(session.vars, name, { value: inherit ? v.value : null, attrs: kept })
  }
}

/**
 * bash's refusal when a declared array kind meets a value of the other
 * kind, or null when they agree.
 */
export function kindConflict(held: ShellValue | null, kind: VarKind | null): string | null {
  if (kind === VarKind.Assoc && Array.isArray(held))
    return 'cannot convert indexed to associative array'
  if (kind === VarKind.Indexed && held !== null && typeof held === 'object' && !Array.isArray(held))
    return 'cannot convert associative to indexed array'
  return null
}

/**
 * What a declaration's `NAME=value` stores, and the elements it assigns
 * (`coerceValue`). An array keeps its kind and takes the value at element 0
 * (key `"0"` in a map), as a plain `NAME=value` does, leaving the other
 * elements as stored; otherwise `-A` makes the map `([0]=value)` and `-a`
 * the one-element array, a held scalar converting to that element first,
 * and with neither the value stays a scalar. `NAME+=value` (`append`)
 * appends to what that slot holds (`S=x; declare -a S+=y` gives
 * `([0]="xy")`), and on an `integer` adds (`appended`).
 */
export function scalarValue(
  held: ShellValue | null,
  value: string,
  kind: VarKind | null,
  append = false,
  integer = false,
): [ShellValue, ReadonlySet<number | string> | null] {
  const scalar = typeof held === 'string' ? held : null
  const map = held !== null && typeof held === 'object' && !Array.isArray(held) ? held : null
  if (map !== null || kind === VarKind.Assoc) {
    const amap: Record<string, string> = { ...map }
    if (scalar !== null) amap['0'] = scalar
    amap['0'] = append ? appended(amap['0'] ?? '', value, integer) : value
    return [amap, new Set(['0'])]
  }
  if (Array.isArray(held) || kind === VarKind.Indexed) {
    const arr: ShellArray = Array.isArray(held) ? [...held] : []
    if (scalar !== null) arr.push(scalar)
    arraySet(arr, 0, append ? appended(arrayGet(arr, 0), value, integer) : value)
    return [arr, new Set([0])]
  }
  return [append ? appended(scalar ?? '', value, integer) : value, null]
}

/**
 * Whether a listing's `-a` / `-A` keep `name`: `-a` lists only indexed
 * arrays, `-A` only associative ones, both nothing.
 */
export function kindListed(
  session: SessionState,
  name: string,
  flags: ReadonlySet<string>,
): boolean {
  if (flags.has('a') && !Object.hasOwn(session.arrays, name)) return false
  return !flags.has('A') || Object.hasOwn(session.assocs, name)
}

/**
 * Put `attr` on the variable a write to `name` landed on. The write's gate
 * covered `checked`, the target before it, so the mark rides on that
 * decision; a write that re-aimed an unset `declare -n` reference
 * (`declare -n r; export r=X`) landed on a target no gate has seen, so that
 * mark goes through the gated session view, as does the reference mark itself
 * (`+n`), which belongs to the reference's own record. `followRef` is false
 * when the write was a `declare -n` declaration's, on the reference itself.
 */
export async function markWritten(
  session: SessionState,
  view: SessionView,
  name: string,
  checked: string,
  attr: VarAttr,
  on = true,
  followRef = true,
): Promise<void> {
  const follows = followRef && attr !== VarAttr.Nameref
  const target = follows ? deref(session, name) || name : name
  if (target === checked) setAttr(session, target, attr, on)
  else await view.mark(name, attr, on, followRef)
}

/**
 * Put a declaration's attribute marks on what one operand landed on, as
 * soon as it lands: `declare -r R=1 R=2` refuses the second write, and
 * under `-g` the global record takes them. A written operand's marks ride
 * on its write's gate (`markWritten`); a bare one (`checked` null) wrote
 * nothing, so each mark goes through the gated session view.
 */
export async function stampMarks(
  session: SessionState,
  view: SessionView,
  name: string,
  checked: string | null,
  marks: AttrMarks,
  followRef = true,
): Promise<void> {
  for (const [attr, on] of marks) {
    if (checked === null) await view.mark(name, attr, on, followRef)
    else await markWritten(session, view, name, checked, attr, on, followRef)
  }
}

/**
 * Take the mark off an unaimed `declare -n` reference a declared array kind
 * is about to land on, silently, as bash's `export -a ref=v` does (an
 * undeclared array warns at the session view).
 */
export async function dropReference(
  session: SessionState,
  view: SessionView,
  name: string,
): Promise<void> {
  const target = deref(session, name) || name
  if (sessionEntry(session.vars, target)?.attrs.has(VarAttr.Nameref) === true) {
    await view.mark(target, VarAttr.Nameref, false)
  }
}

/**
 * A name's own record, undefined when unset or hidden: a hidden name reads
 * as unset, so no refusal can quote or describe its value.
 */
export function visibleRecord(session: SessionState, name: string): ShellVar | undefined {
  if (varHidden(session.visibility, name)) return undefined
  return sessionEntry(session.vars, name)
}

/**
 * The line a `+letter` earns on one operand, if any. Two letters cannot be
 * taken off: `+r` on a readonly name is `declare: R: readonly variable` and
 * the name stays frozen, as is `+n` on a frozen reference; `+a` / `+A` on an array is `cannot destroy array
 * variables in this way`, since the kind is what the value is, not a mark.
 * Either skips that operand's value and marks, and the others still declare
 * (pinned on 5.2.37).
 */
export function plusRefusal(
  cmd: string,
  session: SessionState,
  view: SessionView,
  name: string,
  plus: string,
): string | null {
  const own = visibleRecord(session, name)
  const value = own?.value ?? null
  const reference = own?.attrs.has(VarAttr.Nameref) === true
  if (
    (plus.includes('r') && view.isReadonly(name)) ||
    (plus.includes('n') && reference && view.isReadonly(name, false))
  ) {
    return readonlyLine(cmd, name)
  }
  const isMap = value !== null && typeof value === 'object' && !Array.isArray(value)
  if ((plus.includes('a') && Array.isArray(value)) || (plus.includes('A') && isMap)) {
    return `bash: ${cmd}: ${name}: cannot destroy array variables in this way`
  }
  return null
}

/**
 * Store a declaration's array literals through the session view, the first
 * of bash's two passes over a declaration.
 *
 * bash stores every literal before it runs any other operand, then goes
 * through all of them in order, assigning the plain values and marking each
 * name, a literal's included, at its own place: so `declare -r R=1 R=(2)`
 * stores `(2)`, writes 1 over element 0 and freezes `R`, and a fatal literal
 * leaves every other operand undone (pinned on 5.2.37). Only the
 * value-shaping attributes go on before a literal stores (`shaping`); the
 * caller's second pass puts the rest on the literals `stored` reports, by
 * position, against the variable each write's gate cleared, so an operand
 * that re-aims a reference in between cannot carry a mark past the gate.
 *
 * The builtin owns the store; readonly is the shell's rule, checked per name
 * before the session view, and the session view's gate covers the policy half. Names are
 * processed in order, so an earlier operand stays stored when a later one
 * refuses, as bash does. A readonly refusal or kind conflict of an array
 * literal is a variable-assignment error in GNU, not a builtin failure: for
 * `export`/`readonly` (and `declare` at top level) `fatal` abandons the rest
 * of the line, while `local` and a function-scoped `declare` refuse in the
 * builtin's voice into `errors` and the body keeps running (pinned on bash
 * 5.2, debian:stable-slim); under `-g` a readonly name refuses fatally even
 * inside a function, a kind conflict does not. Returns the refusal result,
 * or null.
 *
 * Inside a function `declare` and `local` make each name local, starting as
 * `startLocal` leaves it (with `-I`, the value it shadows); `export` and
 * `readonly` (`VISIBLE_SCOPE_BUILTINS`) and `-g` write the visible one.
 *
 * `kind` is the kind `-a` / `-A` declared: `-A` builds every literal as an
 * associative map, and without it a name that already holds one still
 * builds a map, since a plain `m+=([k]=v)` keeps the variable's own kind.
 * `warnings` is filled with the `must use subscript` lines for the plain
 * words a keyed associative literal cannot take; GNU stores the valid
 * elements and the status stays 0.
 */
export async function storeStagedArrays(
  cmd: string,
  session: SessionState,
  view: SessionView,
  operands: readonly DeclarationOperand[],
  errors: string[],
  warnings: string[],
  fatal = false,
  stored: Map<number, string> | null = null,
  kind: VarKind | null = null,
  shaping: AttrMarks = [],
  globalScope = false,
  inherit = false,
): Promise<Result | null> {
  const scoped = !globalScope && !VISIBLE_SCOPE_BUILTINS.has(cmd)
  const locals = scoped ? session.localVars : null
  for (const [position, operand] of operands.entries()) {
    if (typeof operand === 'string') continue
    const { name, append, items } = operand
    if (view.isReadonly(name)) {
      if (fatal || globalScope)
        throw new DiscardSignal(encodeText(`bash: ${name}: readonly variable\n`))
      errors.push(readonlyLine(cmd, name))
      continue
    }
    const fresh = locals !== null && !locals.has(name)
    if (locals !== null) shadowLocal(session, locals, name)
    if (fresh && !inCallEnv(session, name)) startLocal(session, name, inherit)
    const held = fresh && !inherit ? null : heldValue(session, name)
    const conflict = kindConflict(held, kind)
    if (conflict !== null) {
      if (fatal) throw new DiscardSignal(encodeText(`bash: ${name}: ${conflict}\n`))
      errors.push(`bash: ${cmd}: ${name}: ${conflict}`)
      continue
    }
    try {
      await premark(view, name, shaping)
      if (kind !== null) await dropReference(session, view, name)
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal(cmd, err)
      throw err
    }
    let base: ShellValue
    const checked = deref(session, name) || name
    // One try around the literal and the write: a subscript in the
    // literal may assign (`([x=2]=v)`), and that lands through the same
    // session view.
    try {
      if (kind === VarKind.Assoc || Object.hasOwn(session.assocs, name)) {
        const { map, badWords } = buildAssocLiteral(session.assocs[name] ?? null, items, append)
        for (const word of badWords) {
          warnings.push(
            `bash: ${name}: '${word}': must use subscript when assigning associative array`,
          )
        }
        base = map
      } else {
        let indexed: ShellArray | null = session.arrays[name] ?? null
        if (append && indexed === null) {
          const scalar = conversionScalar(session, name)
          indexed = scalar === undefined ? null : [scalar]
        }
        base = await buildIndexedLiteral(indexed, items, append, (sub) =>
          subscriptIndex(session, sub, view),
        )
      }
      await view.set(name, base)
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal(cmd, err)
      // An element or subscript of a literal names no builtin, as an
      // assignment's does (`declare -ai A=(2+)` is `2+: ...`).
      if (err instanceof ArithError) throw err.signal('', true)
      throw err
    }
    if (stored !== null) stored.set(position, checked)
  }
  return null
}

function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code < 0x20 || code === 0x7f
}

/**
 * Quote a value the way bash `declare -p` / `export -p` does.
 *
 * A value holding any control character takes the `$'...'` form, with the
 * named escapes bash uses (`\a \b \t \n \v \f \r`, and `\E` for escape) and
 * three-digit octal for the rest; `"`, `$` and backtick need no escaping
 * there because `$'...'` does not expand. Everything else is double-quoted
 * with escapes for `\`, `"`, `$` and backtick. Non-ASCII printable text
 * stays literal, which is what bash emits in a UTF-8 locale.
 */
export function bashDeclareQuote(value: string): string {
  let out = ''
  if (CONTROL_RE.test(value)) {
    for (const ch of value) {
      const escape = ANSI_C_ESCAPES[ch]
      if (escape !== undefined) out += escape
      else if (isControl(ch)) out += `\\${(ch.codePointAt(0) ?? 0).toString(8).padStart(3, '0')}`
      else out += ch
    }
    return `$'${out}'`
  }
  for (const ch of value) {
    if (ch === '\\' || ch === '"' || ch === '$' || ch === '`') out += `\\${ch}`
    else out += ch
  }
  return `"${out}"`
}

export function splitDeclFlags(
  args: readonly DeclarationOperand[],
  allowed: Set<string>,
): { flags: Set<string>; names: DeclarationOperand[]; bad: string | null } {
  const flags = new Set<string>()
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (typeof tok !== 'string') break
    if (tok === '--') {
      i += 1
      break
    }
    if (tok.startsWith('-') && tok.length > 1 && tok !== '-') {
      const body = tok.slice(1)
      for (const ch of body) {
        if (!allowed.has(ch)) return { flags, names: args.slice(i), bad: ch }
      }
      for (const ch of body) flags.add(ch)
      i += 1
      continue
    }
    break
  }
  return { flags, names: args.slice(i), bad: null }
}

/**
 * One associative key as `declare -p` spells it.
 *
 * Bare when every character is one GNU leaves unquoted (pinned by a
 * character sweep on 5.2.37: alphanumerics and `_ % + , - . / : = @ ~`),
 * quoted like a value otherwise. A key that *is* `@` or `*` quotes even
 * though the character is bare mid-key, since the bare spelling would
 * read back as a splat.
 */
function assocKeyText(key: string): string {
  if (key !== '@' && key !== '*' && BARE_KEY_RE.test(key)) return key
  return bashDeclareQuote(key)
}

/**
 * The `=(...)` tail of an associative `declare` line.
 *
 * Sorted keys (mirage's pinned order, where GNU prints hash order) and
 * GNU's trailing space before the closing paren, which an empty map
 * does not carry: `m=([a]="1" )` but `m=()`.
 */
export function assocBody(amap: Readonly<Record<string, string>>): string {
  const keys = Object.keys(amap).sort(compareCodePoints)
  if (keys.length === 0) return '=()'
  const parts = keys.map((k) => `[${assocKeyText(k)}]=${bashDeclareQuote(amap[k] ?? '')}`)
  return `=(${parts.join(' ')} )`
}

/**
 * A declaration operand as its name, whether it appends, and its value, null
 * for a bare name: `X+=y` appends `y` to `X`.
 */
export function operandParts(word: string): [string, boolean, string | null] {
  const eq = word.indexOf('=')
  if (eq < 0) return [word, false, null]
  const name = word.slice(0, eq)
  const append = name.endsWith('+')
  return [append ? name.slice(0, -1) : name, append, word.slice(eq + 1)]
}

/**
 * GNU's `not a valid identifier` line for one declaration operand.
 *
 * A declaration builtin refuses a name it cannot declare rather than
 * storing it: `export 1BAD=x` used to land a variable that `$1BAD` can
 * never name back (bash reads that as `$1` then `BAD`) and then shipped
 * it to every child environment.
 *
 * Which text GNU quotes depends on why the word failed, and both
 * spellings are pinned. A word that is not a valid assignment at all is
 * echoed whole (``export: `1BAD=x'``); a word whose target parses but is
 * not a plain name -- an array element -- is echoed as just that target
 * (``export: `arr[0]'``), since the value it would have taken is not
 * what is wrong with it.
 */
export function identifierRefusal(cmd: string, word: string): string | null {
  const [name] = operandParts(word)
  if (isValidName(name)) return null
  const quoted = SUBSCRIPT_RE.test(name) ? name : word
  return `bash: ${cmd}: \`${quoted}': not a valid identifier`
}

/**
 * A declaration's answer once every operand ran: each warning, then each
 * refusal, one line apiece, and exit 1 when an operand refused; an empty
 * refusal fails without a word, as bash's do for a reference given `-i`. The good
 * operands on the same line are already stored: GNU reports each and keeps
 * going, so `export GOOD=1 1BAD=x GOOD2=2` exports both good names. A
 * warning alone (`must use subscript`) leaves the status 0.
 */
export function declarationResult(
  cmd: string,
  errors: readonly string[],
  warnings: readonly string[] = [],
): Result {
  const lines = [...warnings, ...errors.filter((line) => line !== '')]
  const code = errors.length > 0 ? 1 : 0
  if (lines.length === 0) {
    return [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: cmd, exitCode: code }),
    ]
  }
  const err = encodeText(`${lines.join('\n')}\n`)
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: code, stderr: err }),
  ]
}

/**
 * The `declare -p` line for one name, or null when it has none.
 *
 * The attribute cluster is `attrLetters`, which is why this renders
 * `declare -rx` and `declare -ar` without a table of its own: the record
 * already knows its own letters and their print order. bash spells an
 * empty cluster `--`, and that spelling is the caller's because only a
 * `declare` line needs it.
 *
 * A hidden name answers null, the same way `isReadonly` answers false for
 * one: reporting it as declared would leak it.
 */
export function declareLine(session: SessionState, name: string): string | null {
  if (varHidden(session.visibility, name)) return null
  const v = sessionEntry(session.vars, name)
  if (v === undefined) return null
  const letters = attrLetters(v)
  const head = letters ? `declare -${letters}` : 'declare --'
  if (v.value === null) return `${head} ${name}`
  if (Array.isArray(v.value)) {
    const parts: string[] = []
    for (let i = 0; i < v.value.length; i++) {
      const el = v.value[i]
      if (el !== null && el !== undefined) {
        parts.push(`[${String(i)}]=${bashDeclareQuote(el)}`)
      }
    }
    return `${head} ${name}=(${parts.join(' ')})`
  }
  if (typeof v.value !== 'string') return `${head} ${name}${assocBody(v.value)}`
  return `${head} ${name}=${bashDeclareQuote(v.value)}`
}

/**
 * Run `declare -p`: render declarations for names, or for all.
 *
 * With names, they print in the order given and a name that does not
 * exist is reported on stderr without stopping the rest, exiting 1 at the
 * end -- GNU prints the names it knows and refuses only the ones it does
 * not. Bare `declare -p` lists every visible name sorted.
 */
/**
 * Whether a no-name `declare` listing's letters keep `name`: `-a` / `-A`
 * narrow it to that array kind (`kindListed`), and any of `-i -l -n -r -t
 * -u -x` keeps a name carrying one of them.
 */
export function declarationListed(
  session: SessionState,
  name: string,
  flags: ReadonlySet<string>,
): boolean {
  const v = sessionEntry(session.vars, name)
  if (v === undefined || !kindListed(session, name, flags)) return false
  const letters = new Set(attrLetters(v))
  const wanted = [...flags].filter((c) => LISTED_ATTRIBUTES.has(c))
  return wanted.length === 0 || wanted.some((c) => letters.has(c))
}

/**
 * Run `declare -p`: render declarations for names, or for all; with no
 * names the declaration's letters narrow the list (`declarationListed`).
 */
export function handleDeclarePrint(
  names: string[],
  session: SessionState,
  flags: ReadonlySet<string> = new Set(),
): Result {
  const targets =
    names.length > 0
      ? names
      : Object.keys(session.vars)
          .filter((name) => declarationListed(session, name, flags))
          .sort(compareCodePoints)
  const lines: string[] = []
  const errors: string[] = []
  for (const name of targets) {
    const line = declareLine(session, name)
    if (line === null) errors.push(`bash: declare: ${name}: not found`)
    else lines.push(line)
  }
  const out = lines.length > 0 ? encodeText(`${lines.join('\n')}\n`) : new Uint8Array()
  const err = errors.length > 0 ? encodeText(`${errors.join('\n')}\n`) : undefined
  const code = errors.length > 0 ? 1 : 0
  return [
    out,
    new IOResult({ exitCode: code, ...(err !== undefined ? { stderr: err } : {}) }),
    new ExecutionNode({
      command: 'declare',
      exitCode: code,
      ...(err !== undefined ? { stderr: err } : {}),
    }),
  ]
}

/** The `unset` refusal for a function `readonly -f` froze. */
export function readonlyFunctionUnset(name: string): Result {
  const err = encodeText(`bash: unset: ${name}: cannot unset: readonly function\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
  ]
}

/**
 * The letters `declare` prints a function with: `f`, then `r` when
 * `readonly -f` froze it and `x` when `export -f` marked it.
 */
export function functionFlags(session: SessionState, name: string): string {
  const readonly = session.readonlyFunctions.has(name) ? 'r' : ''
  const exported = session.exportedFunctions.has(name) ? 'x' : ''
  return `f${readonly}${exported}`
}

/**
 * Print functions as `declare` lists them. A body prints as bash renders it
 * (`storedFunctionText`), followed with `marks` by a `declare -fx NAME` line
 * when the function has an attribute; without bodies each function is its
 * `declare` line, or its bare name.
 */
export function functionLines(
  session: SessionState,
  names: readonly string[],
  bodies: boolean,
  marks: boolean,
  parser?: ParseScope,
): string[] {
  const lines: string[] = []
  for (const name of names) {
    const flags = functionFlags(session, name)
    if (bodies) {
      lines.push(storedFunctionText(name, session.functions[name] ?? '', parser))
      if (marks && flags !== 'f') lines.push(`declare -${flags} ${name}`)
    } else {
      lines.push(marks ? `declare -${flags} ${name}` : name)
    }
  }
  return lines
}

/**
 * Run the function half of `declare`: `-f` / `-F`.
 *
 * `-p` only prints, whatever attributes come with it: `-F NAME` the
 * attribute line, `-f NAME` the body and, for a function with an attribute,
 * that line (`functionLines`); a missing name is `not found`, exit 1.
 * Without `-p`, `-r` freezes the named functions as `readonly -f` does, `-x`
 * marks them for export and `+x` takes the mark off, printing nothing; a `+`
 * letter wins over its `-` twin, and `+r` refuses a frozen function, which
 * then keeps every attribute (`readonly function`, exit 1); with no
 * attribute `-F NAME` prints the name and `-f NAME` the body, and a missing
 * name is exit 1 with no message. With no names every function
 * lists as `-p` prints it; `-r` or `-x` narrows the list to the functions
 * holding either attribute, and a `+` attribute does not.
 */
export function handleDeclareFunctions(
  cmd: string,
  session: SessionState,
  flags: ReadonlySet<string>,
  names: readonly string[],
  plus: ReadonlySet<string>,
  parser?: ParseScope,
): Result {
  const printing = flags.has('p')
  const wanted = ['r', 'x'].filter((c) => flags.has(c))
  let present = names.filter((name) => name in session.functions)
  const missing = names.filter((name) => !(name in session.functions))
  const code = missing.length > 0 ? 1 : 0
  if (names.length > 0 && !printing && (wanted.length > 0 || plus.has('r') || plus.has('x'))) {
    const frozen = present.filter((name) => plus.has('r') && session.readonlyFunctions.has(name))
    for (const name of present) {
      if (frozen.includes(name)) continue
      if (flags.has('r') && !plus.has('r')) session.readonlyFunctions.add(name)
      if (plus.has('x')) session.exportedFunctions.delete(name)
      else if (flags.has('x')) session.exportedFunctions.add(name)
    }
    const status = missing.length > 0 || frozen.length > 0 ? 1 : 0
    const err = encodeText(
      frozen.map((name) => `bash: ${cmd}: ${name}: readonly function\n`).join(''),
    )
    return [
      null,
      new IOResult({ exitCode: status, stderr: err.byteLength > 0 ? err : null }),
      new ExecutionNode({ command: cmd, exitCode: status, stderr: err }),
    ]
  }
  if (names.length === 0) {
    present = Object.keys(session.functions)
      .sort(compareCodePoints)
      .filter(
        (name) =>
          wanted.length === 0 || wanted.some((c) => functionFlags(session, name).includes(c)),
      )
  }
  const lines = functionLines(
    session,
    present,
    !flags.has('F'),
    printing || names.length === 0,
    parser,
  )
  const out = encodeText(lines.length > 0 ? `${lines.join('\n')}\n` : '')
  const err = printing
    ? encodeText(missing.map((name) => `bash: ${cmd}: ${name}: not found\n`).join(''))
    : new Uint8Array()
  return [
    out,
    new IOResult({ exitCode: code, stderr: err.byteLength > 0 ? err : null }),
    new ExecutionNode({ command: cmd, exitCode: code, stderr: err }),
  ]
}

/**
 * Run `readonly -f` or `export -f`: mark functions, or list them. A name
 * that is not a function is `not a function`, exit 1, and the other operands
 * are still marked (or, with `on` false, unmarked), in the order typed. An
 * array literal (`export -f ARR=(a b)`) still stores first, with no
 * attribute and its `must use subscript` warnings, and its name is then
 * checked at its place, as bash assigns every literal before it looks for
 * the functions. With no names the marked functions print as bodies, each
 * followed by its `declare` line.
 */
export async function markFunctions(
  cmd: string,
  session: SessionState,
  marked: Set<string>,
  operands: readonly DeclarationOperand[],
  on: boolean,
  state: SessionView | null = null,
  parser?: ParseScope,
  kind: VarKind | null = null,
): Promise<Result> {
  const errors: string[] = []
  const warnings: string[] = []
  if (operands.some((operand) => typeof operand !== 'string')) {
    const refused = await storeStagedArrays(
      cmd,
      session,
      requireView(state),
      operands,
      errors,
      warnings,
      true,
      null,
      kind,
    )
    if (refused !== null) return refused
  }
  const names = operands.map((operand) => (typeof operand === 'string' ? operand : operand.name))
  if (names.length === 0) {
    const listed = [...marked].filter((name) => name in session.functions).sort(compareCodePoints)
    const lines = functionLines(session, listed, true, true, parser)
    const out = encodeText(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: cmd, exitCode: 0 })]
  }
  for (const name of names) {
    if (!(name in session.functions)) errors.push(`bash: ${cmd}: ${name}: not a function`)
    else if (on) marked.add(name)
    else marked.delete(name)
  }
  return declarationResult(cmd, errors, warnings)
}

/**
 * Run `export` or `readonly` over its operands: assign each value and put
 * the keyword's mark on, or with `on` false take it off (`export -n`).
 * bash's two passes (`storeStagedArrays`): every array literal stores first,
 * then each operand in order is assigned and marked, a literal's name at its
 * own place. So `readonly R=1 R=2 X=3` keeps 1, refuses the second write and
 * still sets `X`, and `readonly A=(1) A=(2)` keeps `(2)` while a later `A=3`
 * refuses.
 */
export async function markVariables(
  cmd: string,
  session: SessionState,
  view: SessionView,
  operands: readonly DeclarationOperand[],
  attr: VarAttr,
  on: boolean,
  kind: VarKind | null,
): Promise<Result> {
  const errors: string[] = []
  const warnings: string[] = []
  const stored = new Map<number, string>()
  const refused = await storeStagedArrays(
    cmd,
    session,
    view,
    operands,
    errors,
    warnings,
    true,
    stored,
    kind,
  )
  try {
    for (const [position, operand] of operands.entries()) {
      if (typeof operand === 'string') {
        const line =
          refused !== null ? null : await markOperand(cmd, session, view, operand, attr, on, kind)
        if (line !== null) errors.push(line)
      } else {
        // A literal is marked at its place, even when a policy refused a
        // later literal.
        const checked = stored.get(position)
        if (checked !== undefined) await markWritten(session, view, operand.name, checked, attr, on)
      }
    }
  } catch (err) {
    if (err instanceof PolicyDenied) return refusal(cmd, err)
    if (err instanceof ArithError) throw err.signal(cmd, true)
    throw err
  }
  return refused ?? declarationResult(cmd, errors, warnings)
}

/**
 * Assign and mark one `export` / `readonly` word. A value of the other array
 * kind is refused and the name is still marked, as bash does. The bare form
 * writes no value, so it marks through the session view's no-value call rather than
 * inventing an empty string: on a new name that leaves it *unset* and
 * marked, bash's own third state (`export Z` prints `declare -x Z` and stays
 * out of `env`). Still gated, since marking is a session write: through
 * `setAttr` a deployment refusing `AWS_*` saw `readonly AWS_KEY` exit 0 and
 * freeze the name against every later write. Returns the operand's refusal
 * line, or null; a policy denial or an `-i` value that does not evaluate
 * throws.
 */
async function markOperand(
  cmd: string,
  session: SessionState,
  view: SessionView,
  word: string,
  attr: VarAttr,
  on: boolean,
  kind: VarKind | null,
): Promise<string | null> {
  const badName = identifierRefusal(cmd, word)
  if (badName !== null) return badName
  const [key, append, val] = operandParts(word)
  if (val !== null && view.isReadonly(key)) return readonlyLine(cmd, key)
  const held = val !== null ? heldValue(session, key) : null
  const conflict = val !== null ? kindConflict(held, kind) : null
  if (val !== null && conflict === null) {
    const checked = deref(session, key) || key
    const integer = sessionEntry(session.vars, checked)?.attrs.has(VarAttr.Integer) === true
    const [value, assigned] = scalarValue(held, val, kind, append, integer)
    if (kind !== null) await dropReference(session, view, key)
    await view.set(key, value, true, assigned)
    // Rides on the gate the `view.set` above passed, unless the write
    // re-aimed a reference (`markWritten`).
    await markWritten(session, view, key, checked, attr, on)
  } else {
    await view.mark(key, attr, on)
  }
  if (on) outliveCall(session, key)
  return conflict === null ? null : `bash: ${cmd}: ${key}: ${conflict}`
}

/**
 * Record the caller's array before a function shadows `name`.
 *
 * `local -a` / `declare -a` inside a function shadow the caller's array,
 * so the old value (or its absence) has to be remembered for the teardown
 * in `executeCommand`. Returns true when a function scope is active, so
 * the caller should shadow rather than reuse whatever is already there.
 */
export function noteLocalArray(session: SessionState, name: string): boolean {
  const locals = session.localVars
  if (locals === null) return false
  shadowLocal(session, locals, name)
  return true
}

/**
 * The line `declare -n NAME=TARGET` earns when TARGET is unusable: bash
 * refuses a target that is not a variable name, a self reference, and
 * (mirage-only) a target spelled as an array element, since the resolver
 * maps names to names.
 */
export function namerefRefusal(cmd: string, name: string, target: string): string | null {
  if (SUBSCRIPT_RE.test(target)) {
    return `mirage: ${cmd}: ${target}: name reference to an array element is not supported`
  }
  if (!isValidName(target)) {
    return `bash: ${cmd}: \`${target}': invalid variable name for name reference`
  }
  if (target === name) {
    return `bash: ${cmd}: ${name}: nameref variable self references not allowed`
  }
  return null
}

/**
 * The line the name a `declare -n` operand lands on earns, ahead of its
 * readonly mark (pinned on 5.2.37). An array cannot become a reference
 * (`reference variable cannot be an array`). A given value was judged on
 * its own (`namerefRefusal`); a bare `declare -n NAME` aims the name at the
 * value it already holds, so that value has to name a variable, though here
 * it may name NAME itself.
 */
export function referenceRefusal(
  cmd: string,
  name: string,
  own: ShellVar | undefined,
  bare: boolean,
): string | null {
  if (own !== undefined && own.value !== null && typeof own.value === 'object') {
    return `bash: ${cmd}: ${name}: reference variable cannot be an array`
  }
  if (
    !bare ||
    own === undefined ||
    typeof own.value !== 'string' ||
    own.attrs.has(VarAttr.Nameref) ||
    own.value === name
  ) {
    return null
  }
  return namerefRefusal(cmd, name, own.value)
}
