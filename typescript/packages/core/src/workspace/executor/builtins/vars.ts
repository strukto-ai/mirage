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

import { SHELL_SPECS, parseShellOptions } from '../../../commands/spec/shell.ts'
import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { asyncChain } from '../../../io/stream.ts'
import { IOResult } from '../../../io/types.ts'
import type { ByteSource } from '../../../io/types.ts'
import type { CallStack } from '../../../shell/call_stack.ts'
import { ExitSignal } from '../../../shell/errors.ts'
import { shellJoin } from '../../../shell/join.ts'
import { parseOptionWord } from '../../../shell/options.ts'
import { SET_OPTION_NAMES } from '../../../shell/types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { PolicyDenied } from '../../../policy/errors.ts'
import {
  arrayAppend,
  arrayExtent,
  arrayUnset,
  makeArray,
  type ShellArray,
} from '../../../shell/array.ts'
import { arrayIndex } from '../../expand/variable.ts'
import { ReadonlyVariableError } from '../../session/errors.ts'
import { ownRecord, sessionEntry } from '../../session/session.ts'
import type { Session } from '../../session/session.ts'
import { envSnapshot, sessionView } from '../../session/state.ts'
import type { SessionView } from '../../../ops/types.ts'
import { ExecutionNode } from '../../types.ts'
import { ReturnSignal } from '../control.ts'
import { PRINTF_TARGET_RE } from './text.ts'
import type { ExecuteStringFn, Result } from './scope.ts'
import { compareCodePoints } from '../../../utils/sort.ts'

/**
 * The session view to write through. Production callers thread the
 * workspace's gated view; a direct invocation (a unit test) gets an
 * ungated one over the same session.
 */
function viewOf(session: Session, state: SessionView | null): SessionView {
  return state ?? sessionView(session)
}

/** Render a policy denial in the builtin's own voice. */
function doorRefusal(cmd: string, err: PolicyDenied): Result {
  const encoded = new TextEncoder().encode(`${err.message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/** Render the shell's own readonly refusal, checked before the door. */
function readonlyRefusal(cmd: string, name: string): Result {
  const encoded = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/**
 * Store a declaration's array literals through the session door.
 *
 * The builtin owns the store so a refusal speaks in its own voice:
 * readonly is the shell's rule, checked per name before the door, and
 * the door's gate covers the policy half. Names are processed in
 * order, so an earlier operand stays stored when a later one refuses,
 * as bash does. Returns the refusal result, or null when every
 * literal stored. `mark` also marks each stored name readonly (the
 * `readonly` keyword's half). A readonly refusal of an array literal
 * is a variable-assignment error in GNU, not a builtin failure: for
 * `export`/`readonly` (and `declare` at top level) `fatal` abandons
 * the rest of the line, while `local` and a function-scoped `declare`
 * refuse in the builtin's voice and the body keeps running (pinned on
 * bash 5.2, debian:stable-slim).
 */
async function storeStagedArrays(
  cmd: string,
  session: Session,
  view: SessionView,
  arrays: { name: string; append: boolean; items: string[] }[],
  mark = false,
  fatal = false,
): Promise<Result | null> {
  for (const { name, append, items } of arrays) {
    if (view.isReadonly(name)) {
      if (fatal) {
        const err = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
        throw new ExitSignal(1, err, null, 1)
      }
      return readonlyRefusal(cmd, name)
    }
    noteLocalArray(session, name)
    let base: ShellArray
    if (append) {
      const existing = session.arrays[name]
      if (existing === undefined) {
        const scalar = session.env[name]
        base = scalar === undefined ? [] : [scalar]
      } else {
        base = [...existing]
      }
      arrayAppend(base, items)
    } else {
      base = makeArray(items)
    }
    try {
      await view.set(name, base)
    } catch (err) {
      if (err instanceof PolicyDenied) return doorRefusal(cmd, err)
      throw err
    }
    if (mark) session.readonlyVars.add(name)
  }
  return null
}

const EXPORT_USAGE = 'export: usage: export [-fn] [name[=value] ...] or export -p\n'
const READONLY_USAGE = 'readonly: usage: readonly [-aAf] [name[=value] ...] or readonly -p\n'
const EXPORT_FLAGS = new Set('fnp')
const READONLY_FLAGS = new Set('aAfp')

const ANSI_C_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  "'": "\\'",
  '\x07': '\\a',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
  '\x1b': '\\E',
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/

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
function bashDeclareQuote(value: string): string {
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

function splitDeclFlags(
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

function exportLines(session: Session, flags: Set<string>): string[] {
  // Mirage keeps shell variables in session.env and treats that map as the
  // exported environment (printenv / env already do), so export -p lists it.
  // -f selects shell functions; mirage tracks no export attribute on
  // functions, so that form lists nothing, as bash does with none exported.
  if (flags.has('f')) return []
  return Object.keys(session.env)
    .sort(compareCodePoints)
    .map((name) => `declare -x ${name}=${bashDeclareQuote(session.env[name] ?? '')}`)
}

function readonlyLines(session: Session, flags: Set<string>): string[] {
  // -a narrows to indexed arrays, as bash does. -f selects functions and -A
  // associative arrays, neither of which mirage carries a readonly attribute
  // for, so those forms list nothing.
  if (flags.has('f') || flags.has('A')) return []
  const arraysOnly = flags.has('a')
  const lines: string[] = []
  for (const name of [...session.readonlyVars].sort(compareCodePoints)) {
    const arr = session.arrays[name]
    if (arr !== undefined) {
      const parts: string[] = []
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i]
        if (v !== null && v !== undefined) {
          parts.push(`[${String(i)}]=${bashDeclareQuote(v)}`)
        }
      }
      lines.push(`declare -ar ${name}=(${parts.join(' ')})`)
      continue
    }
    if (arraysOnly) continue
    if (name in session.env) {
      lines.push(`declare -r ${name}=${bashDeclareQuote(session.env[name] ?? '')}`)
    } else {
      lines.push(`declare -r ${name}`)
    }
  }
  return lines
}

/**
 * Mark names for export, or print them (`export -p` / bare `export`).
 *
 * With no name operands, prints every entry in `session.env` as
 * `declare -x NAME="value"`. Invalid option characters fail with status 2.
 * Writes go through the session view, so readonly refusal and the
 * preSession policy gate fire here exactly as for any other writer.
 */
export async function handleExport(
  assignments: string[],
  session: Session,
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
  const view = viewOf(session, state)
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays('export', session, view, arrays, false, true)
    if (refused !== null) return refused
  }
  for (const assign of names) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (view.isReadonly(key)) return readonlyRefusal('export', key)
      try {
        await view.set(key, assign.slice(eq + 1))
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('export', err)
        throw err
      }
    } else if (!(assign in session.env) && !(assign in session.arrays)) {
      // `export NAME` with no value writes an empty entry, which is
      // still a session write; an existing name (scalar or array) is
      // only re-marked for export, so nothing is written — a scalar
      // write here would erase an array.
      if (view.isReadonly(assign)) return readonlyRefusal('export', assign)
      try {
        await view.set(assign, '')
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('export', err)
        throw err
      }
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'export', exitCode: 0 })]
}

/**
 * Mark names readonly, or print them (`readonly -p` / bare `readonly`).
 *
 * With no name operands, prints every readonly name as `declare -r` (or
 * `declare -ar` for arrays). Invalid options fail with status 2.
 */
export async function handleReadonly(
  assignments: string[],
  session: Session,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
): Promise<Result> {
  const { flags, names, bad } = splitDeclFlags(assignments, READONLY_FLAGS)
  if (bad !== null) {
    const err = new TextEncoder().encode(
      `bash: readonly: -${bad}: invalid option\n${READONLY_USAGE}`,
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'readonly', exitCode: 2, stderr: err }),
    ]
  }
  if (names.length === 0 && (arrays === null || arrays.length === 0)) {
    const lines = readonlyLines(session, flags)
    const out = new TextEncoder().encode(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return [out, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
  }
  const view = viewOf(session, state)
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays('readonly', session, view, arrays, true, true)
    if (refused !== null) return refused
  }
  for (const assign of names) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (view.isReadonly(key)) return readonlyRefusal('readonly', key)
      try {
        await view.set(key, assign.slice(eq + 1))
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('readonly', err)
        throw err
      }
      session.readonlyVars.add(key)
    } else {
      session.readonlyVars.add(assign)
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'readonly', exitCode: 0 })]
}

/** Remove a whole scalar or array variable (no subscript). */
function unsetVariable(session: Session, name: string): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.env[name]
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.arrays[name]
  if (name === 'OPTIND') session.getoptsOptind = null
}

/**
 * Clear one array element, or a scalar addressed as `base[0]`.
 *
 * Clearing an element keeps the indices of the elements after it, as bash
 * does: it leaves a hole, which neither expands in `${arr[@]}` nor counts
 * toward `${#arr[@]}` but keeps `${arr[i]}` addressing the same values. A
 * subscript on a scalar names element 0 only: `x[0]` unsets the scalar
 * and any other subscript reports `notarray`. A subscript on a name that
 * holds nothing at all is a silent no-op, but on an existing array a
 * negative subscript still below zero after the extent is added reports
 * `subscript`.
 *
 * The element mechanics are the builtin's own, but every landing write
 * still mutates `base`'s session state, so it clears the plane's gate
 * first: for an array base the view's env half is empty, so `view.unset`
 * is exactly the gate, and for a scalar's element 0 it is the whole
 * unset itself. Validation errors write nothing and so never ask.
 */
async function unsetElement(
  session: Session,
  view: SessionView,
  base: string,
  subscript: string,
): Promise<'ok' | 'notarray' | 'subscript'> {
  const arr = sessionEntry(session.arrays, base)
  if (arr === undefined) {
    if (sessionEntry(session.env, base) === undefined) return 'ok'
    if (arrayIndex(subscript, session.env) !== 0) return 'notarray'
    await view.unset(base)
    return 'ok'
  }
  let idx = arrayIndex(subscript, session.env)
  if (idx < 0) {
    idx += arrayExtent(arr)
    if (idx < 0) return 'subscript'
  }
  const next = [...arr]
  arrayUnset(next, idx)
  await view.set(base, next)
  return 'ok'
}

/**
 * Unset shell variables, arrays, or functions, with bash's flags.
 *
 * `-v` targets a variable only, `-f` a function only, and a bare name a
 * variable if one exists or else a function. A `name[idx]` operand clears
 * one element; the readonly guard resolves it to the base name first,
 * since that is what `readonly` records. `-n` (unset a nameref itself)
 * has no referent here — mirage has no nameref attribute — so it matches
 * bash on a non-nameref name and leaves it untouched.
 */
export async function handleUnset(
  args: string[],
  session: Session,
  state: SessionView | null = null,
): Promise<Result> {
  let mode: 'auto' | 'v' | 'f' | 'n' = 'auto'
  let i = 0
  while (i < args.length && (args[i] ?? '').startsWith('-') && args[i] !== '-') {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (/^-[vfn]+$/.test(tok)) {
      if (tok.includes('f')) mode = 'f'
      else if (tok.includes('n')) mode = 'n'
      else mode = 'v'
      i += 1
      continue
    }
    const err = new TextEncoder().encode(`bash: unset: ${tok}: invalid option\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'unset', exitCode: 2, stderr: err }),
    ]
  }
  for (const name of args.slice(i)) {
    if (mode === 'n') {
      // No nameref attribute exists, so this leaves the name untouched,
      // matching bash on a plain variable.
      continue
    }
    if (mode === 'f') {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.functions[name]
      continue
    }
    const match = PRINTF_TARGET_RE.exec(name)
    const subscript = match?.[2]
    const isElement = subscript !== undefined
    // `readonly arr` records the base name, so an `arr[i]` operand has to
    // be resolved before the guard, as bash does (which also names the
    // base, not the element, in the error).
    const base = match?.[1] ?? name
    if (session.readonlyVars.has(base)) {
      const err = new TextEncoder().encode(
        `bash: unset: ${base}: cannot unset: readonly variable\n`,
      )
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    const existed = isElement || name in session.env || name in session.arrays
    // Both spellings clear the preSession gate for the base name: the
    // whole-variable unset through the view's env half, an element
    // unset inside unsetElement, so `unset 'X[0]'` cannot sidestep a
    // policy that vetoes `unset X`.
    let status: 'ok' | 'notarray' | 'subscript'
    try {
      if (subscript !== undefined) {
        status = await unsetElement(session, viewOf(session, state), base, subscript)
      } else {
        await viewOf(session, state).unset(name)
        unsetVariable(session, name)
        status = 'ok'
      }
    } catch (err) {
      if (err instanceof PolicyDenied) return doorRefusal('unset', err)
      throw err
    }
    if (status !== 'ok') {
      // bash names the base for "not an array variable" but prints only
      // the bracketed part for a bad subscript.
      const detail =
        status === 'notarray'
          ? `unset: ${base}: not an array variable`
          : `unset: ${name.slice(base.length)}: bad array subscript`
      const err = new TextEncoder().encode(`bash: ${detail}\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: 'unset', exitCode: 1, stderr: err }),
      ]
    }
    if (mode === 'auto' && !existed && name in session.functions) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete session.functions[name]
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'unset', exitCode: 0 })]
}

export function handlePrintenv(name: string | null, session: Session): Result {
  if (name !== null) {
    const val = session.env[name]
    if (val === undefined) {
      return [
        null,
        new IOResult({ exitCode: 1 }),
        new ExecutionNode({ command: 'printenv', exitCode: 1 }),
      ]
    }
    const out = new TextEncoder().encode(`${val}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
  }
  const lines = Object.entries(session.env).map(([k, v]) => `${k}=${v}`)
  lines.sort(compareCodePoints)
  const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'printenv', exitCode: 0 })]
}

const ENV_HELP_HINT = "Try 'env --help' for more information.\n"

function envError(message: string): Result {
  const err = new TextEncoder().encode(`${message}\n${ENV_HELP_HINT}`)
  return [
    null,
    new IOResult({ exitCode: 125, stderr: err }),
    new ExecutionNode({ command: 'env', exitCode: 125, stderr: err }),
  ]
}

export async function handleEnv(
  executeFn: ExecuteStringFn,
  args: string[],
  session: Session,
  stdin: ByteSource | null = null,
): Promise<Result> {
  let ignoreEnv = false
  let nullSep = false
  const unset: string[] = []
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      i += 1
      break
    }
    if (tok === '-i' || tok === '--ignore-environment') {
      ignoreEnv = true
      i += 1
      continue
    }
    if (tok === '-0' || tok === '--null') {
      nullSep = true
      i += 1
      continue
    }
    if (tok === '-') {
      // GNU: "a mere - implies -i".
      ignoreEnv = true
      i += 1
      continue
    }
    if (tok === '--unset') {
      if (i + 1 >= args.length) {
        return envError("env: option '--unset' requires an argument")
      }
      unset.push(args[i + 1] ?? '')
      i += 2
      continue
    }
    if (tok.startsWith('--unset=')) {
      unset.push(tok.slice('--unset='.length))
      i += 1
      continue
    }
    if (tok.startsWith('--')) {
      return envError(`env: unrecognized option '${tok}'`)
    }
    if (tok.startsWith('-') && tok.length > 1) {
      let j = 1
      let consumedNext = false
      let errored: string | null = null
      while (j < tok.length) {
        const ch = tok[j]
        if (ch === 'i') {
          ignoreEnv = true
        } else if (ch === '0') {
          nullSep = true
        } else if (ch === 'u') {
          const rest = tok.slice(j + 1)
          if (rest !== '') {
            unset.push(rest)
          } else if (i + 1 < args.length) {
            unset.push(args[i + 1] ?? '')
            consumedNext = true
          } else {
            errored = "env: option requires an argument -- 'u'"
          }
          break
        } else {
          errored = `env: invalid option -- '${ch ?? ''}'`
          break
        }
        j += 1
      }
      if (errored !== null) return envError(errored)
      i += consumedNext ? 2 : 1
      continue
    }
    break
  }

  const dropSet = new Set(unset)
  const source = ignoreEnv ? {} : envSnapshot(session)
  const base: Record<string, string> = ownRecord()
  for (const [k, v] of Object.entries(source)) {
    if (!dropSet.has(k)) base[k] = v
  }
  while (i < args.length && (args[i] ?? '').includes('=') && !(args[i] ?? '').startsWith('=')) {
    const tok = args[i] ?? ''
    const eq = tok.indexOf('=')
    base[tok.slice(0, eq)] = tok.slice(eq + 1)
    i += 1
  }

  const command = args.slice(i)
  if (command.length > 0 && nullSep) {
    return envError('env: cannot specify --null (-0) with command')
  }
  if (command.length === 0) {
    const sep = nullSep ? '\0' : '\n'
    const out = new TextEncoder().encode(
      Object.entries(base)
        .map(([k, v]) => `${k}=${v}${sep}`)
        .join(''),
    )
    return [out, new IOResult(), new ExecutionNode({ command: 'env', exitCode: 0 })]
  }

  const saved = session.env
  session.env = base
  try {
    const io = await executeFn(shellJoin(command), { sessionId: session.sessionId, stdin })
    return [io.stdout, io, new ExecutionNode({ command: 'env', exitCode: io.exitCode })]
  } finally {
    session.env = saved
  }
}

export function handleWhoami(namespace: Namespace): Result {
  // GNU whoami reports the effective user and never consults $USER; the
  // workspace user (launch agentId, shared via the namespace store) is
  // the effective identity here. With no claimed identity it fails like
  // GNU does for a uid with no passwd entry.
  if (namespace.user === null) {
    const err = new TextEncoder().encode('whoami: cannot find name for user ID\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'whoami', exitCode: 1, stderr: err }),
    ]
  }
  const out = new TextEncoder().encode(`${namespace.user}\n`)
  return [out, new IOResult(), new ExecutionNode({ command: 'whoami', exitCode: 0 })]
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
  const localArrays = session.localArrays
  if (localArrays === null) return false
  if (!localArrays.has(name)) {
    const existing = sessionEntry(session.arrays, name)
    localArrays.set(name, existing === undefined ? null : [...existing])
  }
  return true
}

export async function handleLocal(
  assignments: string[],
  session: Session,
  state: SessionView | null = null,
  arrays: { name: string; append: boolean; items: string[] }[] | null = null,
): Promise<Result> {
  const locals = session.localVars
  const view = viewOf(session, state)
  if (arrays !== null && arrays.length > 0) {
    const refused = await storeStagedArrays(
      'local',
      session,
      view,
      arrays,
      false,
      session.localArrays === null,
    )
    if (refused !== null) return refused
  }
  for (const assign of assignments) {
    const eq = assign.indexOf('=')
    if (eq >= 0) {
      const key = assign.slice(0, eq)
      if (view.isReadonly(key)) return readonlyRefusal('local', key)
      if (locals !== null && !locals.has(key)) {
        locals.set(key, key in session.env ? (session.env[key] ?? null) : null)
      }
      try {
        await view.set(key, assign.slice(eq + 1))
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('local', err)
        throw err
      }
    } else {
      if (locals !== null && !locals.has(assign)) {
        locals.set(assign, assign in session.env ? (session.env[assign] ?? null) : null)
      }
      if (!(assign in session.env) && !(assign in session.arrays)) {
        // A bare declaration of an existing array re-scopes it; a
        // scalar write here would erase it.
        if (view.isReadonly(assign)) return readonlyRefusal('local', assign)
        try {
          await view.set(assign, '')
        } catch (err) {
          if (err instanceof PolicyDenied) return doorRefusal('local', err)
          throw err
        }
      }
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'local', exitCode: 0 })]
}

function isShiftCount(word: string): boolean {
  const body = word.startsWith('-') || word.startsWith('+') ? word.slice(1) : word
  return /^\d+$/.test(body)
}

/** Shift positional parameters, with bash's argument checks. */
export function handleShift(
  args: readonly string[],
  callStack: CallStack | null,
  session: Session | null = null,
): Result {
  if (args.length > 1) {
    const err = new TextEncoder().encode('shift: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    const err = new TextEncoder().encode(`shift: ${first}: numeric argument required\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'shift', exitCode: 1 }),
    ]
  }
  const n = first !== undefined ? Number(first) : 1
  let shifted = false
  if (callStack !== null && callStack.getAllPositional().length > 0) {
    callStack.shift(n)
    shifted = true
  }
  if (!shifted && session !== null) {
    session.positionalArgs = session.positionalArgs.slice(n)
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'shift', exitCode: 0 })]
}

export function handleSet(
  args: string[],
  session: Session,
  _callStack: CallStack | null = null,
): Result {
  if (args.length === 0) {
    const lines = Object.entries(session.env).map(([k, v]) => `${k}=${v}`)
    lines.sort(compareCodePoints)
    const out = new TextEncoder().encode(`${lines.join('\n')}\n`)
    return [out, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
  }
  let i = 0
  while (i < args.length) {
    const tok = args[i] ?? ''
    if (tok === '--') {
      session.positionalArgs = args.slice(i + 1)
      return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
    }
    const word = parseOptionWord(tok, args[i + 1] ?? null)
    if (word === null) {
      session.positionalArgs = args.slice(i)
      break
    }
    for (const [option, enable] of word.settings) {
      // `-o` takes a name rather than a letter, and a name bash does not
      // have is the one thing it refuses: exit 2, and the settings already
      // applied stay applied while the rest of the line is dropped.
      // Without this a typo — or an option mirage has yet to wire, as
      // `physical` once was — reads as success.
      if (!SET_OPTION_NAMES.has(option)) {
        const err = new TextEncoder().encode(`set: ${option}: invalid option name\n`)
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: 'set', exitCode: 2, stderr: err }),
        ]
      }
      session.shellOptions[option] = enable
    }
    // A letter naming no option is ignored rather than refused: bash has
    // options mirage does not implement (`-a`, `-B`, `-H`), and `set` is
    // where a script turns those on without wanting to fail. A nested shell
    // answers the same leftovers differently, which is why the grammar hands
    // them back instead of deciding here.
    i += word.consumed
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'set', exitCode: 0 })]
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isValidName(name: string): boolean {
  return IDENTIFIER_RE.test(name)
}

async function getoptsFinish(
  session: Session,
  view: SessionView,
  name: string,
  optValue: string,
  optarg: string | null,
  newOptind: number,
  newPos: number,
  exitCode: number,
  stderr: Uint8Array | null = null,
): Promise<Result> {
  // The name is assigned last, exactly as bash does: OPTIND/OPTARG and
  // the hidden cursor still advance, but a bad destination fails the
  // write and turns the call into a status-1 error. Writes go through
  // the session view, so a preSession policy or a readonly OPTARG /
  // OPTIND refuses here too.
  try {
    if (!isValidName(name)) {
      stderr = new TextEncoder().encode(`bash: getopts: \`${name}': not a valid identifier\n`)
      exitCode = 1
    } else if (session.readonlyVars.has(name)) {
      stderr = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
      exitCode = 1
    } else {
      await view.set(name, optValue)
    }
    if (optarg === null) await view.unset('OPTARG')
    else await view.set('OPTARG', optarg)
    await view.set('OPTIND', String(newOptind))
  } catch (err) {
    if (err instanceof ReadonlyVariableError) {
      stderr = new TextEncoder().encode(`bash: ${err.varName}: readonly variable\n`)
      exitCode = 1
    } else if (err instanceof PolicyDenied) {
      stderr = new TextEncoder().encode(`${err.message}\n`)
      exitCode = 1
    } else {
      throw err
    }
  }
  session.getoptsPos = newPos
  session.getoptsOptind = newOptind
  const io = new IOResult(stderr === null ? { exitCode } : { exitCode, stderr })
  const node =
    stderr === null
      ? new ExecutionNode({ command: 'getopts', exitCode })
      : new ExecutionNode({ command: 'getopts', exitCode, stderr })
  return [null, io, node]
}

/** Parse one option per call, with bash's getopts semantics. */
export async function handleGetopts(
  args: readonly string[],
  session: Session,
  callStack: CallStack | null = null,
  state: SessionView | null = null,
): Promise<Result> {
  if (args.length < 2) {
    const err = new TextEncoder().encode('getopts: usage: getopts optstring name [arg]\n')
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'getopts', exitCode: 2, stderr: err }),
    ]
  }
  const view = viewOf(session, state)
  const optstring = args[0] ?? ''
  const name = args[1] ?? ''
  let params: readonly string[]
  if (args.length > 2) params = args.slice(2)
  else if (callStack !== null && callStack.getAllPositional().length > 0)
    params = callStack.getAllPositional()
  else params = session.positionalArgs
  const silent = optstring.startsWith(':')
  const verbose = !silent && (session.env.OPTERR ?? '1') !== '0'
  const parsed = Number.parseInt(session.env.OPTIND ?? '1', 10)
  let optind = Number.isNaN(parsed) ? 1 : parsed
  // Bash treats a nonpositive OPTIND as a restart at argument 1.
  const restart = optind < 1
  if (restart) optind = 1
  if (restart || session.getoptsOptind !== optind) session.getoptsPos = 0
  let pos = session.getoptsPos

  if (optind > params.length) {
    return getoptsFinish(session, view, name, '?', null, optind, 0, 1)
  }
  const word = params[optind - 1] ?? ''
  // A stale cursor left past the end of the current word (a shorter or
  // reused argument) restarts the scan rather than reading undefined.
  if (pos >= word.length) pos = 0
  if (pos === 0) {
    if (!word.startsWith('-') || word === '-') {
      return getoptsFinish(session, view, name, '?', null, optind, 0, 1)
    }
    if (word === '--') return getoptsFinish(session, view, name, '?', null, optind + 1, 0, 1)
    pos = 1
  }

  const letter = word[pos] ?? ''
  const rest = word.slice(pos + 1)
  const idx = optstring.indexOf(letter)
  const isValid = letter !== ':' && idx !== -1
  const takesArg = isValid && idx + 1 < optstring.length && optstring[idx + 1] === ':'
  const enc = new TextEncoder()

  if (!isValid) {
    const [afterOptind, afterPos] = rest ? [optind, pos + 1] : [optind + 1, 0]
    if (silent) return getoptsFinish(session, view, name, '?', letter, afterOptind, afterPos, 0)
    const err = verbose ? enc.encode(`bash: illegal option -- ${letter}\n`) : null
    return getoptsFinish(session, view, name, '?', null, afterOptind, afterPos, 0, err)
  }

  if (!takesArg) {
    const [afterOptind, afterPos] = rest ? [optind, pos + 1] : [optind + 1, 0]
    return getoptsFinish(session, view, name, letter, null, afterOptind, afterPos, 0)
  }

  if (rest) return getoptsFinish(session, view, name, letter, rest, optind + 1, 0, 0)
  if (optind < params.length) {
    return getoptsFinish(session, view, name, letter, params[optind] ?? '', optind + 2, 0, 0)
  }
  if (silent) return getoptsFinish(session, view, name, ':', letter, optind + 1, 0, 0)
  const err = verbose ? enc.encode(`bash: option requires an argument -- ${letter}\n`) : null
  return getoptsFinish(session, view, name, '?', null, optind + 1, 0, 0, err)
}

export function handleTrap(_session: Session): Result {
  return [null, new IOResult(), new ExecutionNode({ command: 'trap', exitCode: 0 })]
}

/** Return from a function or sourced script, with bash's checks. */
export function handleReturn(
  args: readonly string[],
  session: Session,
  callStack: CallStack | null = null,
): Result {
  const inFunction = callStack !== null && callStack.depth > 1
  if (!inFunction && session.sourceDepth === 0) {
    // bash prints the diagnostic, sets $? to 2, and carries on with
    // the rest of the line.
    const err = new TextEncoder().encode(
      "return: can only `return' from a function or sourced script\n",
    )
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 2, stderr: err }),
    ]
  }
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    // bash prints the error and the function returns 2.
    throw new ReturnSignal(
      2,
      new TextEncoder().encode(`return: ${first}: numeric argument required\n`),
    )
  }
  if (args.length > 1) {
    const err = new TextEncoder().encode('return: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'return', exitCode: 1, stderr: err }),
    ]
  }
  // A bare return propagates the status of the last command executed.
  throw new ReturnSignal(
    first !== undefined ? ((Number(first) % 256) + 256) % 256 : session.lastExitCode,
  )
}

/** Exit the shell, with bash's argument checks. */
export function handleExit(args: readonly string[], session: Session): Result {
  const first = args[0]
  if (first !== undefined && !isShiftCount(first)) {
    // bash exits with 2 after the diagnostic.
    throw new ExitSignal(2, new TextEncoder().encode(`exit: ${first}: numeric argument required\n`))
  }
  if (args.length > 1) {
    // bash refuses to exit and the command fails with 1.
    const err = new TextEncoder().encode('exit: too many arguments\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: 'exit', exitCode: 1, stderr: err }),
    ]
  }
  const code = first !== undefined ? Number(first) : session.lastExitCode
  throw new ExitSignal(((code % 256) + 256) % 256)
}

/** Split on whitespace runs with a maxsplit, like Python's split(None, n). */
function splitOnWhitespace(text: string, maxsplit: number): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /[ \t\n]/.test(text[i] ?? '')) i++
    if (i >= text.length) break
    if (out.length === maxsplit) {
      out.push(text.slice(i))
      return out
    }
    let j = i
    while (j < text.length && !/[ \t\n]/.test(text[j] ?? '')) j++
    out.push(text.slice(i, j))
    i = j
  }
  return out
}

/**
 * Read one line into variables, with bash's option handling.
 *
 * Only -r is accepted (our read is already raw, so it is consumed with
 * no effect); anything else errors like bash instead of being treated
 * as a variable name.
 */
export async function handleRead(
  args: string[],
  session: Session,
  stdin: ByteSource | null,
  state: SessionView | null = null,
): Promise<Result> {
  const parse = parseShellOptions(SHELL_SPECS.read, args)
  if (parse.invalid !== null) {
    const token = parse.invalid.startsWith('--') ? parse.invalid : `-${parse.invalid}`
    const err = new TextEncoder().encode(`read: ${token}: invalid option\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'read', exitCode: 2 }),
    ]
  }
  const variables = parse.operands.length > 0 ? parse.operands : ['REPLY']
  // A NEW stdin source replaces any leftover buffer (a previous
  // command's exhausted herestring/pipe must not shadow this one); the
  // SAME source object reuses the buffer so sequential reads advance
  // through its lines.
  if (stdin !== null && (session.stdinBuffer === null || session.stdinSource !== stdin)) {
    if (stdin instanceof Uint8Array) {
      session.stdinBuffer = new AsyncLineIterator(asyncChain(stdin))
    } else {
      session.stdinBuffer = new AsyncLineIterator(stdin)
    }
    session.stdinSource = stdin
  }
  let lineBytes: Uint8Array | null = null
  if (session.stdinBuffer !== null) {
    lineBytes = await session.stdinBuffer.readline()
  }
  const view = viewOf(session, state)
  if (lineBytes === null) {
    for (const v of variables) {
      if (view.isReadonly(v)) return readonlyRefusal('read', v)
      try {
        await view.set(v, '')
      } catch (err) {
        if (err instanceof PolicyDenied) return doorRefusal('read', err)
        throw err
      }
    }
    return [
      null,
      new IOResult({ exitCode: 1 }),
      new ExecutionNode({ command: 'read', exitCode: 1 }),
    ]
  }
  const decodedLine = new TextDecoder().decode(lineBytes)
  let lineEnd = decodedLine.length
  while (lineEnd > 0 && decodedLine.charCodeAt(lineEnd - 1) === 10) lineEnd--
  const line = decodedLine.slice(0, lineEnd)
  const ifs = session.env.IFS ?? ' \t\n'
  let parts: string[]
  if (ifs === ' \t\n') {
    // GNU trims IFS whitespace from both ends before splitting; the
    // remainder assigned to the last variable keeps inner whitespace.
    parts = splitOnWhitespace(line.replace(/^[ \t\n]+|[ \t\n]+$/g, ''), variables.length - 1)
  } else if (ifs === '') {
    parts = [line]
  } else {
    const ifsWs = new Set<string>(
      ifs.split('').filter((c) => c === ' ' || c === '\t' || c === '\n'),
    )
    let start = 0
    let end = line.length
    while (start < end && ifsWs.has(line[start] ?? '')) start++
    while (end > start && ifsWs.has(line[end - 1] ?? '')) end--
    const work = line.slice(start, end)
    const nSplits = Math.max(0, variables.length - 1)
    const chars = new Set(ifs.split(''))
    const out: string[] = []
    let cur = ''
    for (const ch of work) {
      if (chars.has(ch) && out.length < nSplits) {
        out.push(cur)
        cur = ''
        continue
      }
      cur += ch
    }
    out.push(cur)
    parts = out
  }
  for (let i = 0; i < variables.length; i++) {
    const name = variables[i]
    if (name === undefined) continue
    if (view.isReadonly(name)) return readonlyRefusal('read', name)
    try {
      await view.set(name, parts[i] ?? '')
    } catch (err) {
      if (err instanceof PolicyDenied) return doorRefusal('read', err)
      throw err
    }
  }
  return [null, new IOResult(), new ExecutionNode({ command: 'read', exitCode: 0 })]
}

/**
 * `source FILE` / `. FILE` — read a script file and execute it.
 * Mirrors Python's `mirage.workspace.executor.builtins.handle_source`.
 */
