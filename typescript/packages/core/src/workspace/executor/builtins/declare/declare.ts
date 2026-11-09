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

import { shellVoice } from '../../../../shell/voice.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import type { Shell, ShellTask } from '../../../../rs/shell.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { CallStack } from '../../../../shell/call_stack.ts'
import { shellJoin } from '../../../../shell/join.ts'
import type { ParseScope } from '../../../../shell/parse/scope.ts'
import { storedFunctionText } from '../../../../shell/printer.ts'
import { VarAttr } from '../../../../shell/variable.ts'
import { compareCodePoints } from '../../../../utils/sort.ts'
import type { EvaluationContext } from '../../../evaluation.ts'
import { runOnShell } from '../../../expand/node.ts'
import type { ExecuteFn } from '../../../expand/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { deciding, prefixTemporaries } from '../../../session/state.ts'
import { ExecutionNode } from '../../../types.ts'
import { bodyAliasValues } from '../alias/alias.ts'
import { builtinUsage, fail, ok, result, written } from '../shared.ts'
import type { BuiltinCall } from '../types.ts'
import { EXPORT_FLAGS, READONLY_FLAGS } from './constants.ts'
import type { DeclarationOperand } from './types.ts'

/**
 * Run a declaration on the session's shell and answer what it printed.
 * Mirrors Python's declared.
 */
export async function declared(
  cmd: string,
  start: (shell: Shell) => ShellTask,
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
): Promise<RedirectResult> {
  const [pieces, status] = (await runOnShell(start, context, executeFn, callStack)) as readonly [
    readonly (readonly [boolean, Uint8Array])[],
    number,
  ]
  return written(cmd, pieces, status)
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
    if (tok.startsWith('-') && tok.length > 1) {
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
      lines.push(
        storedFunctionText(
          name,
          session.functions[name] ?? '',
          parser,
          bodyAliasValues(session, name),
        ),
      )
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
): RedirectResult {
  const printing = flags.has('p')
  const wanted = ['r', 'x'].filter((c) => flags.has(c))
  const present = names.filter((name) => name in session.functions)
  const missing = names.filter((name) => !(name in session.functions))
  if (names.length > 0 && !printing && (wanted.length > 0 || plus.has('r') || plus.has('x'))) {
    const frozen = present.filter((name) => plus.has('r') && session.readonlyFunctions.has(name))
    for (const name of present) {
      if (frozen.includes(name)) continue
      if (flags.has('r') && !plus.has('r')) session.readonlyFunctions.add(name)
      if (plus.has('x')) session.exportedFunctions.delete(name)
      else if (flags.has('x')) session.exportedFunctions.add(name)
    }
    return result(cmd, {
      exitCode: missing.length > 0 || frozen.length > 0 ? 1 : 0,
      stderr: frozen.map((name) => `${shellVoice()}${cmd}: ${name}: readonly function\n`).join(''),
    })
  }
  const listing = names.length === 0
  const shown = listing
    ? Object.keys(session.functions)
        .sort(compareCodePoints)
        .filter(
          (name) =>
            wanted.length === 0 || wanted.some((c) => functionFlags(session, name).includes(c)),
        )
    : names
  const pieces: [boolean, string][] = []
  for (const name of shown) {
    if (name in session.functions) {
      for (const line of functionLines(
        session,
        [name],
        !flags.has('F'),
        printing || listing,
        parser,
      ))
        pieces.push([false, `${line}\n`])
    } else if (printing) pieces.push([true, `${shellVoice()}${cmd}: ${name}: not found\n`])
  }
  return written(cmd, pieces, missing.length > 0 ? 1 : 0)
}

/**
 * Run `export` or `readonly`: mark names, or print them. An invalid option
 * letter fails with status 2 and the usage line. `-f` marks functions instead
 * (`markFunctions`); the variables' half runs on the shell. Mirrors Python's
 * mark_names.
 */
export async function markNames(
  assignments: readonly DeclarationOperand[],
  context: EvaluationContext,
  executeFn: ExecuteFn,
  callStack: CallStack | null,
  attr: VarAttr,
  parser?: ParseScope,
): Promise<RedirectResult> {
  const session = context.session
  const exporting = attr === VarAttr.Export
  const cmd = exporting ? 'export' : 'readonly'
  const { flags, names, bad } = splitDeclFlags(
    assignments,
    exporting ? EXPORT_FLAGS : READONLY_FLAGS,
  )
  if (bad !== null) {
    const usage = builtinUsage(exporting ? 'export' : 'readonly')
    return fail(cmd, `${shellVoice()}${cmd}: -${bad}: invalid option\n${usage}`, 2)
  }
  const on = !flags.has('n')
  const marking =
    (functions: boolean) =>
    (shell: Shell): ShellTask =>
      shell.markNames(
        cmd,
        attr,
        on,
        [...flags].sort(compareCodePoints).join(''),
        names,
        prefixTemporaries(session),
        functions,
        deciding(),
      )
  if (!flags.has('f')) return declared(cmd, marking(false), context, executeFn, callStack)
  const marked = exporting ? session.exportedFunctions : session.readonlyFunctions
  const staged = names.every((name) => typeof name === 'string')
    ? [[], 0]
    : await runOnShell(marking(true), context, executeFn, callStack)
  return markFunctions(
    cmd,
    session,
    marked,
    names,
    on,
    staged as readonly [readonly (readonly [boolean, Uint8Array])[], number],
    parser,
  )
}

/**
 * Run `readonly -f` or `export -f`: mark functions, or list them. A name
 * that is not a function is `not a function`, exit 1, and the other operands
 * are still marked (or, with `on` false, unmarked), in the order typed. An
 * array literal (`export -f ARR=(a b)`) still stores first, and its name is
 * then checked at its place, as bash assigns every literal before it looks
 * for the functions. With no names the marked functions print as bodies, each
 * followed by its `declare` line. Mirrors Python's mark_functions.
 */
export function markFunctions(
  cmd: string,
  session: SessionState,
  marked: Set<string>,
  operands: readonly DeclarationOperand[],
  on: boolean,
  [said, status]: readonly [readonly (readonly [boolean, Uint8Array])[], number],
  parser?: ParseScope,
): RedirectResult {
  if (status !== 0) return written(cmd, said, status)
  const names = operands.map((operand) => (typeof operand === 'string' ? operand : operand.name))
  if (names.length === 0) {
    const listed = [...marked].filter((name) => name in session.functions).sort(compareCodePoints)
    const lines = functionLines(session, listed, true, true, parser)
    return ok(cmd, encodeText(lines.map((line) => `${line}\n`).join('')))
  }
  const errors: (readonly [boolean, string])[] = []
  for (const name of names) {
    if (!(name in session.functions))
      errors.push([true, `${shellVoice()}${cmd}: ${name}: not a function\n`])
    else if (on) marked.add(name)
    else marked.delete(name)
  }
  return written(cmd, [...said, ...errors], errors.length > 0 ? 1 : 0)
}

/**
 * The `declare`, `typeset` and `readonly` arm, for a name the parser did not
 * read as a declaration: after an assignment (`n=1 declare -p n`) or from an
 * expansion (`$d -p n`). The words run again as the declaration they spell,
 * as `command` runs them, the name's alias masked: bash expands none in a
 * word that came from an expansion. Mirrors Python's declaration_builtin.
 */
export async function declarationBuiltin(call: BuiltinCall): Promise<RedirectResult> {
  const session = call.context.session
  const name = call.argv.name
  const savedAlias = session.aliases[name]
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete session.aliases[name]
  try {
    const io = await call.executeFn(shellJoin([name, ...call.argv.args]), {
      sessionId: session.sessionId,
      stdin: call.stdin,
      ...(call.callStack !== null ? { callStack: call.callStack } : {}),
    })
    return [io.stdout, io, new ExecutionNode({ command: name, exitCode: io.exitCode })]
  } finally {
    if (savedAlias !== undefined) session.aliases[name] = savedAlias
  }
}
