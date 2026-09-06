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
import { ArithError, ExitSignal } from '../../../../shell/errors.ts'
import { PolicyDenied } from '../../../../policy/errors.ts'
import { buildAssocLiteral, buildIndexedLiteral, type ShellArray } from '../../../../shell/array.ts'
import { varHidden } from '../../../../utils/hidden.ts'
import { sessionEntry, setSessionEntry } from '../../../session/session.ts'
import type { ShellValue, VarAttr } from '../../../../shell/variable.ts'
import { attrLetters } from '../../../../shell/variable.ts'
import { conversionScalar, setAttr, shadowLocal, subscriptIndex } from '../../../session/state.ts'
import type { Session } from '../../../session/session.ts'
import type { SessionView } from '../../../../ops/types.ts'
import { ExecutionNode } from '../../../types.ts'
import { arithRefusal, isValidName, readonlyRefusal, refusal } from '../shared.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import { ANSI_C_ESCAPES, BARE_KEY_RE, CONTROL_RE, SUBSCRIPT_RE } from './constants.ts'
import type { Result } from '../types.ts'

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
export async function storeStagedArrays(
  cmd: string,
  session: Session,
  view: SessionView,
  arrays: { name: string; append: boolean; items: string[] }[],
  mark: VarAttr | null = null,
  on = true,
  fatal = false,
  stored: string[] | null = null,
  assoc = false,
  errors: string[] | null = null,
  shaping: ReadonlySet<VarAttr> = new Set(),
  globalScope = false,
): Promise<Result | null> {
  for (const { name, append, items } of arrays) {
    if (view.isReadonly(name)) {
      if (fatal) {
        const err = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
        throw new ExitSignal(1, err, null, 1)
      }
      return readonlyRefusal(cmd, name)
    }
    if (!globalScope) noteLocalArray(session, name)
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
      if (assoc || Object.hasOwn(session.assocs, name)) {
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
    if (mark !== null) setAttr(session, name, mark, on)
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
  const err = new TextEncoder().encode(`${errors.join('\n')}\n`)
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
export function declareLine(session: Session, name: string): string | null {
  if (varHidden(session.hiddenVars, name)) return null
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
export function handleDeclarePrint(names: string[], session: Session): Result {
  const targets = names.length > 0 ? names : Object.keys(session.vars).sort(compareCodePoints)
  const lines: string[] = []
  const errors: string[] = []
  for (const name of targets) {
    const line = declareLine(session, name)
    if (line === null) errors.push(`bash: declare: ${name}: not found`)
    else lines.push(line)
  }
  const enc = new TextEncoder()
  const out = lines.length > 0 ? enc.encode(`${lines.join('\n')}\n`) : new Uint8Array()
  const err = errors.length > 0 ? enc.encode(`${errors.join('\n')}\n`) : undefined
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
  const err = new TextEncoder().encode(`bash: unset: ${name}: cannot unset: readonly function\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: err }),
    new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
  ]
}

/**
 * Run `readonly -f`: freeze the named functions, or list the frozen.
 *
 * A frozen function refuses redefinition and `unset -f` with its own
 * message, exit 1, and the old body stays. A name that is not a
 * function is `not a function`, exit 1, and the other operands still
 * freeze. With no names, lists the frozen functions as `declare -fr
 * NAME`; GNU prints each body first through its own pretty-printer,
 * which mirage does not carry, so the body line is the one deliberate
 * omission.
 */
export function readonlyFunctions(session: Session, names: readonly string[]): Result {
  if (names.length === 0) {
    const lines = [...session.readonlyFunctions]
      .filter((name) => name in session.functions)
      .sort(compareCodePoints)
      .map((name) => `declare -fr ${name}`)
    const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
  }
  const errors: string[] = []
  for (const name of names) {
    if (!(name in session.functions)) {
      errors.push(`bash: readonly: ${name}: not a function`)
      continue
    }
    session.readonlyFunctions.add(name)
  }
  if (errors.length > 0) {
    const err = new TextEncoder().encode(`${errors.join('\n')}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'readonly', exitCode: 1, stderr: err }),
    ]
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}

/**
 * Run the function half of `declare`: `-f` / `-F` / `-rf`.
 *
 * `-F NAME` prints the name; `-f NAME` prints `declare -f NAME` where
 * GNU prints the reformatted body (mirage carries no pretty-printer, so
 * the name row is the deliberate stand-in, the same shape `-F` and
 * `readonly -f` list in). A missing name is exit 1 with no message.
 * With `-r` the named functions freeze, as `readonly -f` does. With no
 * names, `-F` lists every function and `-f` lists them the same way.
 */
export function handleDeclareFunctions(
  cmd: string,
  session: Session,
  flags: ReadonlySet<string>,
  names: readonly string[],
): Result {
  if (flags.has('r')) return readonlyFunctions(session, names)
  const targets = names.length > 0 ? names : Object.keys(session.functions).sort(compareCodePoints)
  const lines: string[] = []
  let missing = false
  for (const name of targets) {
    if (!(name in session.functions)) {
      missing = true
      continue
    }
    if (flags.has('F')) lines.push(names.length > 0 ? name : `declare -f ${name}`)
    else lines.push(`declare -f ${name}`)
  }
  const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
  const code = missing ? 1 : 0
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: cmd, exitCode: code }),
  ]
}

/**
 * Record the caller's array before a function shadows `name`.
 *
 * `local -a` / `declare -a` inside a function shadow the caller's array,
 * so the old value (or its absence) has to be remembered for the teardown
 * in `executeCommand`. Returns true when a function scope is active, so
 * the caller should shadow rather than reuse whatever is already there.
 */
export function noteLocalArray(session: Session, name: string): boolean {
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
  session: Session,
  view: SessionView,
  key: string,
  value: ShellValue,
): Promise<void> {
  const outer = session.localFrames.find((frame) => frame.has(key))
  if (outer === undefined) {
    await view.set(key, value)
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
    await view.set(key, value)
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
