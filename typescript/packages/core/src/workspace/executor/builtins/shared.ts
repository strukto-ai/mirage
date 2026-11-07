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

import { shellVoice } from '../../../shell/voice.ts'
import { specOf } from '../../../commands/spec/builtins.ts'
import { FlagView } from '../../../commands/spec/flag_view.ts'
import { SHELL_SYNOPSES } from '../../../commands/spec/synopsis.ts'
import type { RedirectResult } from '../../../context/session_context.ts'
import { GlobLimitError } from '../../../errors/types.ts'
import { IOResult } from '../../../io/types.ts'
import type { PolicyDenied } from '../../../policy/errors.ts'
import type { DispatchFn } from '../../../runtime/types.ts'
import { decodeText, encodeText } from '../../../shell/bytes.ts'
import { TooManyMatches } from '../../../shell/errors.ts'
import { PathSpec } from '../../../types.ts'
import { resolvePath } from '../../../utils/path.ts'
import type { SessionView } from '../../../view/types.ts'
import { expandGlob } from '../../expand/globs.ts'
import { expandSubscript } from '../../expand/node.ts'
import type { SubscriptFn } from '../../expand/types.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { ExecutionNode } from '../../types.ts'
import { optionError, parseFlags } from '../command/flags.ts'
import type { ParsedCommand } from '../command/types.ts'
import { COUNT_WORD_RE, IDENTIFIER_RE } from './constants.ts'
import type { BuiltinCall } from './types.ts'

/**
 * Build the (stream, IOResult, ExecutionNode) triple builtins return.
 *
 * @param cmd - command name recorded on the ExecutionNode.
 * @param init - `out` stdout payload; `exitCode` for both results; `stderr`
 *   error text encoded onto both; `io` a prebuilt IOResult to reuse (e.g.
 *   carrying writes), whose exitCode/stderr are overwritten.
 */
export function result(
  cmd: string,
  init: {
    out?: Uint8Array | null
    exitCode?: number
    stderr?: string
    io?: IOResult
  } = {},
): RedirectResult {
  const exitCode = init.exitCode ?? 0
  const err =
    init.stderr !== undefined && init.stderr !== '' ? encodeText(init.stderr) : new Uint8Array()
  const io = init.io ?? new IOResult()
  io.exitCode = exitCode
  if (err.length > 0) io.stderr = err
  return [init.out ?? null, io, new ExecutionNode({ command: cmd, exitCode, stderr: err })]
}

export function ok(cmd: string, out?: Uint8Array | null): RedirectResult {
  return result(cmd, { out: out ?? null })
}

export function fail(cmd: string, message: string, exitCode = 1): RedirectResult {
  return result(cmd, { exitCode, stderr: message })
}

/**
 * Close an operand loop: exit 1 with joined stderr when any operand failed,
 * exit 0 otherwise.
 *
 * @param cmd - command name.
 * @param errors - per-operand error messages collected so far.
 * @param io - prebuilt IOResult to reuse (e.g. carrying writes).
 */
export function finish(cmd: string, errors: string[], io?: IOResult): RedirectResult {
  const carried = io !== undefined ? { io } : {}
  if (errors.length > 0) {
    return result(cmd, { exitCode: 1, stderr: errors.join(''), ...carried })
  }
  return result(cmd, carried)
}

/**
 * Parse a builtin's words with its spec, the way getopt_long does: options
 * may follow operands until `--`, long options take their unique
 * abbreviations, and a bad one is refused in GNU's words with the `Try`
 * line. The operands keep the PathSpecs the classifier made. Mirrors
 * Python's parse_line.
 *
 * @param cmd - the builtin's name.
 * @param args - the classified words after the name.
 * @param cwd - the session working directory.
 */
export function parseLine(
  cmd: string,
  args: readonly (string | PathSpec)[],
  cwd: string,
): [ParsedCommand, FlagView, RedirectResult | null] {
  const spec = specOf(cmd)
  const parsed = parseFlags(args, spec, cmd, cwd)
  const refused = optionError(cmd, parsed)
  if (refused !== null) {
    const [message, code] = refused
    return [parsed, new FlagView({}, spec), fail(cmd, decodeText(message), code)]
  }
  return [parsed, new FlagView(parsed.flagKwargs, spec), null]
}

/**
 * A path operand as an absolute virtual path.
 *
 * @param arg - a classified command part.
 * @param cwd - session working directory for relative operands.
 */
export function absPath(arg: string | PathSpec, cwd: string): string {
  if (arg instanceof PathSpec) return arg.virtual
  return resolvePath(arg, cwd)
}

export interface SplitValueFlags {
  flags: Set<string>
  values: Map<string, string>
  operands: (string | PathSpec)[]
  bad: string | null
}

/**
 * Coerce operands to PathSpec and expand glob patterns per mount, through the
 * dispatcher's listings.
 *
 * A pattern spec only exists for a mounted word (classification gates it), so
 * the lookup propagates on a miss; a backend that lists nothing keeps the
 * literal spec.
 *
 * @param namespace - addressing authority (mount lookup).
 * @param dispatch - op dispatcher the patterns list through.
 * @param operands - positional operands.
 */
export async function expandOperands(
  namespace: Namespace,
  dispatch: DispatchFn,
  operands: readonly (string | PathSpec)[],
): Promise<PathSpec[]> {
  const out: PathSpec[] = []
  for (const item of operands) {
    const spec = item instanceof PathSpec ? item : PathSpec.fromStrPath(item)
    if (spec.pattern !== null) {
      const mount = namespace.mountFor(spec.virtual)
      try {
        for (const item of await expandGlob(dispatch, mount, [spec], mount.vfs.walkLimit))
          out.push(item)
      } catch (err) {
        if (err instanceof GlobLimitError) throw new TooManyMatches(err.message)
        throw err
      }
      continue
    }
    out.push(spec)
  }
  return out
}

/**
 * The gated session view this builtin writes through.
 *
 * Every session write goes through the workspace's gated view, which is
 * what makes `preSession` rules enforceable; this used to fall back to
 * an ungated view over the same session, so a caller that forgot to
 * thread one silently wrote past every policy. A write reached without
 * a view is a wiring bug, not a mode, so it throws.
 */
export function requireView(state: SessionView | null): SessionView {
  if (state === null) {
    throw new Error(
      "builtin reached a session write without the workspace's gated " +
        'session view; thread state from the executor arm',
    )
  }
  return state
}

/** Render a policy denial in the builtin's own voice. */
export function refusal(cmd: string, err: PolicyDenied): RedirectResult {
  const encoded = encodeText(`${err.message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/**
 * The shell's own readonly refusal line, checked before the session view.
 * `declare`, `local` and `typeset` name themselves in it (`bash: declare: R:
 * readonly variable`); every other writer refuses in the assignment's voice
 * (`bash: R: readonly variable`).
 */
export function readonlyLine(cmd: string, name: string): string {
  const voice = cmd === 'declare' || cmd === 'local' || cmd === 'typeset' ? `${cmd}: ` : ''
  return `${shellVoice()}${voice}${name}: readonly variable`
}

/** Render the readonly refusal (`readonlyLine`) as the result. */
export function readonlyRefusal(cmd: string, name: string): RedirectResult {
  const encoded = encodeText(`${readonlyLine(cmd, name)}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/** A count option's value (`read -n`/`-N`, `mapfile -n`/`-s` and the rest): a run of ASCII digits, else null. */
export function countOperand(text: string): number | null {
  return /^[0-9]+$/.test(text) ? parseInt(text, 10) : null
}

/** Whether the word is a shell identifier. */
export function isValidName(name: string): boolean {
  return IDENTIFIER_RE.test(name)
}

/**
 * Whether the word is an optionally signed run of digits, which is what
 * `shift`, `return` and `exit` accept as their argument.
 */
export function isCountWord(word: string): boolean {
  if (!COUNT_WORD_RE.test(word)) return false
  const value = BigInt(word.trim())
  return value >= -(2n ** 63n) && value < 2n ** 63n
}

/** A shell builtin's diagnostic in bash's voice. Mirrors Python's builtin_error. */
export function builtinError(name: string, message: string): Uint8Array {
  return encodeText(`${shellVoice()}${name}: ${message}\n`)
}

/**
 * A builtin's usage line, which bash prints after refusing one of its
 * options: the synopsis `help NAME` opens with. Mirrors Python's
 * builtin_usage.
 */
export function builtinUsage(name: string): string {
  const synopsis = SHELL_SYNOPSES[name]
  if (synopsis === undefined) throw new Error(`no synopsis: ${name}`)
  return `${name}: usage: ${synopsis}\n`
}

/**
 * The words a numeric builtin reads: a leading `--` ends its options, and
 * bash skips it before it reads the number. Mirrors Python's numeric_operands.
 */
export function numericOperands(args: readonly string[]): readonly string[] {
  return args[0] === '--' ? args.slice(1) : args
}

/** A count word's value modulo 256, the status bash keeps of it. */
export function statusOf(word: string): number {
  return Number(((BigInt(word.trim()) % 256n) + 256n) % 256n)
}

/**
 * The byte `read -d` and `mapfile -d` stop at. Bash takes the first byte of
 * the argument, not its first character (bash 5.2: `-d é` stops at 0xc3,
 * `-d $'\xff'` at the raw byte); an empty argument is NUL and no `-d` is a
 * newline. Mirrors Python's record_delimiter.
 */
export function recordDelimiter(text: string | null): number {
  if (text === null) return 10
  return encodeText(text)[0] ?? 0
}

/**
 * How the call's builtin expands a subscript it was given as text
 * (`unset 'a[$i]'`), in the call's session and frame.
 */
export function subscriptExpansion(call: BuiltinCall): SubscriptFn {
  return (text) =>
    expandSubscript(text, call.context, call.executeFn, call.callStack, call.registry.policies)
}
