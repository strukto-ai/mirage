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

import { specOf } from '../../../commands/spec/builtins.ts'
import { FlagView } from '../../../commands/spec/flag_view.ts'
import { IOResult } from '../../../io/types.ts'
import type { SessionView } from '../../../view/types.ts'
import type { PolicyDenied } from '../../../policy/errors.ts'
import type { ArithError } from '../../../shell/errors.ts'
import { PathSpec, wordText } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { ExecutionNode } from '../../types.ts'
import { optionError, parseFlags } from '../command/flags.ts'
import type { ParsedCommand } from '../command/types.ts'
import { COUNT_WORD_RE, IDENTIFIER_RE } from './constants.ts'
import type { Result } from './types.ts'
import { decodeText, encodeText } from '../../../shell/bytes.ts'

interface ResultInit {
  out?: Uint8Array | null
  exitCode?: number
  stderr?: string
  io?: IOResult
}

/**
 * Build the (stream, IOResult, ExecutionNode) triple builtins return.
 *
 * @param cmd - command name recorded on the ExecutionNode.
 * @param init - `out` stdout payload; `exitCode` for both results; `stderr`
 *   error text encoded onto both; `io` a prebuilt IOResult to reuse (e.g.
 *   carrying writes), whose exitCode/stderr are overwritten.
 */
export function result(cmd: string, init: ResultInit = {}): Result {
  const exitCode = init.exitCode ?? 0
  const err =
    init.stderr !== undefined && init.stderr !== '' ? encodeText(init.stderr) : new Uint8Array()
  const io = init.io ?? new IOResult()
  io.exitCode = exitCode
  if (err.length > 0) io.stderr = err
  return [init.out ?? null, io, new ExecutionNode({ command: cmd, exitCode, stderr: err })]
}

export function ok(cmd: string, out?: Uint8Array | null): Result {
  return result(cmd, { out: out ?? null })
}

export function fail(cmd: string, message: string, exitCode = 1): Result {
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
export function finish(cmd: string, errors: string[], io?: IOResult): Result {
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
): [ParsedCommand, FlagView, Result | null] {
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
 * A non-path operand's text (a mode or owner spec the classifier may have
 * wrapped as a path).
 *
 * @param arg - a classified command part.
 */
export function operandText(arg: string | PathSpec): string {
  return arg instanceof PathSpec ? arg.virtual : arg
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
 * Split leading flags where some take a value (`-t STAMP`), strictly: an
 * unknown letter is reported instead of tolerated.
 *
 * @param args - args after the command name.
 * @param boolean - single-letter flags with no value.
 * @param valued - single-letter flags that consume the next arg.
 */
export function splitValueFlags(
  args: readonly (string | PathSpec)[],
  boolean: string,
  valued: string,
): SplitValueFlags {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (arg === undefined) break
    const s = operandText(arg)
    if (parsing && s === '--') {
      parsing = false
      i += 1
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && !s.startsWith('--')) {
      const body = s.slice(1)
      for (let j = 0; j < body.length; j++) {
        const c = body.charAt(j)
        if (boolean.includes(c)) {
          flags.add(c)
          continue
        }
        // A valued flag consumes the rest of the token (-tSTAMP) or the next
        // argument (-t STAMP); those trailing chars are its value, not flags,
        // so validation must stop here rather than pre-scanning the token.
        if (!valued.includes(c)) {
          return { flags, values, operands, bad: c }
        }
        const rest = body.slice(j + 1)
        if (rest.length > 0) {
          values.set(c, rest)
        } else if (i + 1 < args.length) {
          i += 1
          const nxt = args[i]
          if (nxt !== undefined) values.set(c, wordText(nxt))
        }
        break
      }
      i += 1
      continue
    }
    parsing = false
    operands.push(arg)
    i += 1
  }
  return { flags, values, operands, bad: null }
}

/**
 * Coerce operands to PathSpec and expand glob patterns per mount.
 *
 * A pattern spec only exists for a mounted word (classification gates it), so
 * the lookup propagates on a miss; a backend with no glob keeps the literal
 * spec.
 *
 * @param namespace - addressing authority (mount lookup).
 * @param operands - positional operands.
 */
export async function expandOperands(
  namespace: Namespace,
  operands: readonly (string | PathSpec)[],
): Promise<PathSpec[]> {
  const out: PathSpec[] = []
  for (const item of operands) {
    const spec = item instanceof PathSpec ? item : PathSpec.fromStrPath(item)
    if (spec.pattern !== null) {
      const mount = namespace.mountFor(spec.virtual)
      if (mount.answers('glob')) {
        const prefix = rstripSlash(mount.prefix)
        const withPrefix = new PathSpec({
          virtual: spec.virtual,
          directory: spec.directory,
          pattern: spec.pattern,
          resolved: spec.resolved,
          vfsPath: mountKey(spec.virtual, prefix),
        })
        const expanded = await mount.expandGlob([withPrefix], prefix)
        for (const p of expanded) if (p instanceof PathSpec) out.push(p)
        continue
      }
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
export function refusal(cmd: string, err: PolicyDenied): Result {
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
  return `bash: ${voice}${name}: readonly variable`
}

/** Render the readonly refusal (`readonlyLine`) as the result. */
export function readonlyRefusal(cmd: string, name: string): Result {
  const encoded = encodeText(`${readonlyLine(cmd, name)}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/**
 * Render the `-i` coercion's arithmetic error as bash does.
 *
 * GNU voices it as the evaluator's own line, prefixed by the builtin and
 * the offending text (`bash: read: 1+: syntax error: operand expected`),
 * and fails the builtin with 1 while the variable keeps its old value,
 * which is what the session view's copy-then-store already guarantees. A plain
 * assignment (`n=1+`) is fatal instead and is voiced by the executor
 * without a builtin name.
 */
export function arithRefusal(cmd: string, err: ArithError): Result {
  const encoded = encodeText(`bash: ${cmd}: ${err.message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
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
  return encodeText(`bash: ${name}: ${message}\n`)
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
