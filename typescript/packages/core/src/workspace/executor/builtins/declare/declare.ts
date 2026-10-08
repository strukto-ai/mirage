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
  arraySet,
  buildAssocLiteral,
  buildIndexedLiteral,
  type ShellArray,
} from '../../../../shell/array.ts'
import { varHidden } from '../../../../utils/hidden.ts'
import { sessionEntry, setSessionEntry } from '../../../session/session.ts'
import type { ShellValue, VarAttr } from '../../../../shell/variable.ts'
import { attrLetters, VarKind } from '../../../../shell/variable.ts'
import {
  conversionScalar,
  deref,
  setAttr,
  shadowLocal,
  subscriptIndex,
} from '../../../session/state.ts'
import type { SessionState } from '../../../session/session.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, isValidName, readonlyRefusal, refusal, requireView } from '../shared.ts'
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
import { encodeText } from '../../../../shell/bytes.ts'

export async function premark(
  view: SessionView,
  name: string,
  shaping: ReadonlySet<VarAttr>,
): Promise<void> {
  for (const attr of shaping) await view.mark(name, attr, true)
}

/**
 * Store a declaration's array literals through the session door.
 *
 * The builtin owns the store so a refusal speaks in its own voice:
 * readonly is the shell's rule, checked per name before the door, and
 * the door's gate covers the policy half. Names are processed in
 * order, so an earlier operand stays stored when a later one refuses,
 * as bash does. Returns the refusal result, or null when every
 * literal stored.
 *
 * `mark` is the attribute the declaring keyword puts on each stored
 * name: Readonly for `readonly`, Export for `export`. An attribute
 * rather than a bool because both keywords stage array literals through
 * here and hardcoding one of them silently dropped the other:
 * `export ARR=(a b)` stored the array and never marked it, so GNU's
 * `declare -ax` came out `declare -a`.
 *
 * `stored` is filled with each name that actually stored, in order. A
 * declaration keeps its valid operands when a sibling refuses, so the
 * caller cannot read "what was written" off the aggregate exit status.
 *
 * `on` is the direction of that mark. `export -n ARR=(b)` stores the
 * array and takes the attribute *off*, and the store keeps whatever the
 * name already carried, so leaving the mark unapplied left an exported
 * array exported.
 *
 * A readonly refusal of an array literal is a variable-assignment error
 * in GNU, not a builtin failure: for `export`/`readonly` (and `declare`
 * at top level) `fatal` abandons the rest of the line, while `local`
 * and a function-scoped `declare` refuse in the builtin's voice and the
 * body keeps running (pinned on bash 5.2, debian:stable-slim).
 *
 * `assoc` means the declaration carried `-A`, so every literal builds
 * an associative map; without it a name that already holds one still
 * builds a map, since a plain `m+=([k]=v)` keeps the variable's own
 * kind. `errors` is filled with bash-voiced refusal lines for the
 * plain words a keyed associative literal cannot take; the caller
 * folds them into its exit status, because GNU stores the valid
 * elements and still fails the builtin.
 */
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
 * reference names, and under `-g` the global record a function's local
 * shadows.
 */
export function heldValue(
  session: SessionState,
  name: string,
  globalScope = false,
): ShellValue | null {
  const target = deref(session, name) || name
  if (globalScope) {
    const frame = session.localFrames.find((f) => f.has(target))
    if (frame !== undefined) return frame.get(target)?.value ?? null
  }
  return sessionEntry(session.vars, target)?.value ?? null
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
 * the one-element array, and with neither the value stays a scalar.
 */
export function scalarValue(
  held: ShellValue | null,
  value: string,
  kind: VarKind | null,
): [ShellValue, ReadonlySet<number | string> | null] {
  const map = held !== null && typeof held === 'object' && !Array.isArray(held) ? held : null
  if (map !== null || kind === VarKind.Assoc) return [{ ...map, '0': value }, new Set(['0'])]
  if (Array.isArray(held) || kind === VarKind.Indexed) {
    const arr: ShellArray = Array.isArray(held) ? [...held] : []
    arraySet(arr, 0, value)
    return [arr, new Set([0])]
  }
  return [value, null]
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

export async function storeStagedArrays(
  cmd: string,
  session: SessionState,
  view: SessionView,
  arrays: { name: string; append: boolean; items: string[] }[],
  mark: VarAttr | null = null,
  on = true,
  fatal = false,
  stored: string[] | null = null,
  kind: VarKind | null = null,
  errors: string[] | null = null,
  shaping: ReadonlySet<VarAttr> = new Set(),
  globalScope = false,
): Promise<Result | null> {
  for (const { name, append, items } of arrays) {
    if (view.isReadonly(name)) {
      if (fatal) {
        throw new DiscardSignal(encodeText(`bash: ${name}: readonly variable\n`))
      }
      return readonlyRefusal(cmd, name)
    }
    // Inside a function `declare` and `local` make the name local, which
    // shadows the caller's variable so its kind is free; `export`,
    // `readonly` and `-g` write the visible one.
    const shadowed =
      !globalScope && !VISIBLE_SCOPE_BUILTINS.has(cmd) && noteLocalArray(session, name)
    const conflict = shadowed ? null : kindConflict(heldValue(session, name, globalScope), kind)
    if (conflict !== null) {
      if (fatal) throw new DiscardSignal(encodeText(`bash: ${name}: ${conflict}\n`))
      const line = `bash: ${cmd}: ${name}: ${conflict}`
      if (errors === null) return identifierFailure(cmd, [line])
      errors.push(line)
      continue
    }
    try {
      await premark(view, name, shaping)
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal(cmd, err)
      throw err
    }
    let base: ShellValue
    // One try around the literal and the write: a subscript in the
    // literal may assign (`([x=2]=v)`), and that lands through the same
    // door.
    try {
      if (kind === VarKind.Assoc || Object.hasOwn(session.assocs, name)) {
        const { map, badWords } = buildAssocLiteral(session.assocs[name] ?? null, items, append)
        if (errors !== null) {
          for (const word of badWords) {
            errors.push(
              `bash: ${name}: '${word}': must use subscript when assigning associative array`,
            )
          }
        }
        base = map
      } else {
        let held: ShellArray | null = session.arrays[name] ?? null
        if (append && held === null) {
          const scalar = conversionScalar(session, name)
          held = scalar === undefined ? null : [scalar]
        }
        base = await buildIndexedLiteral(held, items, append, (sub) =>
          subscriptIndex(session, sub, view),
        )
      }
      if (globalScope) await writeGlobal(session, view, name, base)
      else await view.set(name, base)
    } catch (err) {
      if (err instanceof PolicyDenied) return refusal(cmd, err)
      if (err instanceof ArithError) return arithRefusal(cmd, err)
      throw err
    }
    if (stored !== null) stored.push(name)
    // Ungated on purpose: the `view.set` immediately above put this same
    // name through the gate, so re-asking would show a policy two writes
    // for one operand.
    if (mark !== null) setAttr(session, deref(session, name) || name, mark, on)
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
  args: string[],
  allowed: Set<string>,
): { flags: Set<string>; names: string[]; bad: string | null } {
  const flags = new Set<string>()
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
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
 * Mark names for export, or print them (`export -p` / bare `export`).
 *
 * With no name operands, prints every entry in `session.env` as
 * `declare -x NAME="value"`. Invalid option characters fail with status 2.
 * Writes go through the session view, so readonly refusal and the
 * preSession policy gate fire here exactly as for any other writer.
 */
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
  const eq = word.indexOf('=')
  const name = eq >= 0 ? word.slice(0, eq) : word
  if (isValidName(name)) return null
  const quoted = SUBSCRIPT_RE.test(name) ? name : word
  return `bash: ${cmd}: \`${quoted}': not a valid identifier`
}

/**
 * Render the refusals collected while declaring names.
 *
 * One line per bad operand, exit 1, and the good operands on the same
 * line are already stored: GNU reports each and keeps going, so
 * `export GOOD=1 1BAD=x GOOD2=2` exports both good names.
 */
export function identifierFailure(cmd: string, errors: string[]): Result {
  const err = encodeText(`${errors.join('\n')}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
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
 * are still marked (or, with `on` false, unmarked). An array literal
 * (`export -f ARR=(a b)`) still stores first, with no attribute, and its name
 * is then checked like the others, as bash assigns it before it looks for
 * the function. With no names the marked functions print as bodies, each
 * followed by its `declare` line.
 */
export async function markFunctions(
  cmd: string,
  session: SessionState,
  marked: Set<string>,
  names: readonly string[],
  on: boolean,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
  parser?: ParseScope,
  kind: VarKind | null = null,
): Promise<Result> {
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays(
      cmd,
      session,
      requireView(state),
      arrays,
      null,
      true,
      true,
      null,
      kind,
    )
    if (refused !== null) return refused
    names = [...names, ...arrays.map(({ name }) => name)]
  }
  if (names.length === 0) {
    const listed = [...marked].filter((name) => name in session.functions).sort(compareCodePoints)
    const lines = functionLines(session, listed, true, true, parser)
    const out = encodeText(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: cmd, exitCode: 0 })]
  }
  const errors: string[] = []
  for (const name of names) {
    if (!(name in session.functions)) errors.push(`bash: ${cmd}: ${name}: not a function`)
    else if (on) marked.add(name)
    else marked.delete(name)
  }
  if (errors.length > 0) {
    const err = encodeText(`${errors.join('\n')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmd, exitCode: 1, stderr: err }),
    ]
  }
  return [null, new IOResult(), new ExecutionNode({ command: cmd, exitCode: 0 })]
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
 * Declare names in the running function's scope, or globally.
 *
 * `cmd` is the spelling that reached here: `declare` and `typeset` route
 * through this handler and must say their own name in a diagnostic, not
 * `local`.
 */
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
 * Store a `declare -g` value on the global record. Outside a function,
 * or for a name no frame on the call path shadows, an ordinary write;
 * otherwise the running locals live in `session.vars` and the global
 * record is what the outermost shadowing frame saved, so the write goes
 * through the door with the two swapped for its duration.
 */
export async function writeGlobal(
  session: SessionState,
  view: SessionView,
  key: string,
  value: ShellValue,
  assigned: ReadonlySet<number | string> | null = null,
): Promise<void> {
  const outer = session.localFrames.find((frame) => frame.has(key))
  if (outer === undefined) {
    await view.set(key, value, true, assigned)
    return
  }
  const shadowing = sessionEntry(session.vars, key)
  const saved = outer.get(key) ?? null
  if (saved === null) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete session.vars[key]
  } else {
    setSessionEntry(session.vars, key, saved)
  }
  try {
    await view.set(key, value, true, assigned)
    outer.set(key, sessionEntry(session.vars, key) ?? null)
  } finally {
    if (shadowing === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.vars[key]
    } else {
      setSessionEntry(session.vars, key, shadowing)
    }
  }
}
