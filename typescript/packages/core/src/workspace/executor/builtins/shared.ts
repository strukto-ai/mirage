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

import { IOResult } from '../../../io/types.ts'
import type { SessionView } from '../../../ops/types.ts'
import type { PolicyDenied } from '../../../policy/errors.ts'
import type { ArithError } from '../../../shell/errors.ts'
import { PathSpec, wordText } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { resolvePath } from '../../../utils/path.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { Namespace } from '../../mount/namespace/namespace.ts'
import { ExecutionNode } from '../../types.ts'
import { IDENTIFIER_RE } from './constants.ts'
import type { Result } from './types.ts'

const ENC = new TextEncoder()

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
    init.stderr !== undefined && init.stderr !== '' ? ENC.encode(init.stderr) : new Uint8Array()
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

function allKnown(chars: string, known: string): boolean {
  for (const c of chars) if (!known.includes(c)) return false
  return true
}

/**
 * Split leading single-letter flags, permissively.
 *
 * A token containing any unknown letter is kept as an operand instead of
 * erroring (`ln`/`readlink` behavior).
 *
 * @param args - args after the command name.
 * @param known - accepted single-letter flags.
 * @returns [flags, operands].
 */
export function splitFlags(
  args: (string | PathSpec)[],
  known: string,
): [Set<string>, (string | PathSpec)[]] {
  const flags = new Set<string>()
  const operands: (string | PathSpec)[] = []
  let parsing = true
  for (const arg of args) {
    const s = operandText(arg)
    if (parsing && s === '--') {
      parsing = false
      continue
    }
    if (parsing && s !== '-' && s.length >= 2 && s.startsWith('-') && allKnown(s.slice(1), known)) {
      for (const c of s.slice(1)) flags.add(c)
      continue
    }
    parsing = false
    operands.push(arg)
  }
  return [flags, operands]
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
      if (mount.resource.glob !== undefined) {
        const prefix = rstripSlash(mount.prefix)
        const withPrefix = new PathSpec({
          virtual: spec.virtual,
          directory: spec.directory,
          pattern: spec.pattern,
          resolved: spec.resolved,
          resourcePath: mountKey(spec.virtual, prefix),
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
  const encoded = new TextEncoder().encode(`${err.message}\n`)
  return [
    null,
    new IOResult({ exitCode: 1, stderr: encoded }),
    new ExecutionNode({ command: cmd, exitCode: 1, stderr: encoded }),
  ]
}

/** Render the shell's own readonly refusal, checked before the door. */
// Render the mirage read-only refusal, naming the mount.
//
// The voice `Mount.executeCmd` uses when a command's own mount region is
// unwritable, so a refusal reached from anywhere else says the same
// thing: `rm` of a symlink is answered by the node table rather than the
// mount, and rendering it in GNU's per-operand voice made one read-only
// grant speak twice about the same mount.
//
// It names the mount, not the operand, so two refused operands on one
// mount produce one line and callers collecting several must drop the
// duplicates. A refusal keyed to a *path* rather than a mount region (a
// read-only rename destination on another mount) is not this message:
// those keep GNU's per-operand wording, as the backend path does.
//
// A path no mount owns (an attr overlay or link above every mount, gated
// on its `/` turf) has no prefix to blame, so the refusal keeps GNU's own
// phrase instead of naming a mount that is not there. Mirrors Python's
// read_only_error.
export function readOnlyError(cmd: string, namespace: Namespace, path: PathSpec): string {
  const mount = namespace.tryMountFor(path.virtual)
  if (mount === null) return `${cmd}: ${path.virtual}: Read-only file system\n`
  return `${cmd}: read-only mount at ${mount.prefix}\n`
}

export function readonlyRefusal(cmd: string, name: string): Result {
  const encoded = new TextEncoder().encode(`bash: ${name}: readonly variable\n`)
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
 * which is what the door's copy-then-store already guarantees. A plain
 * assignment (`n=1+`) is fatal instead and is voiced by the executor
 * without a builtin name.
 */
export function arithRefusal(cmd: string, err: ArithError): Result {
  const encoded = new TextEncoder().encode(`bash: ${cmd}: ${err.message}\n`)
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
  const body = word.startsWith('-') || word.startsWith('+') ? word.slice(1) : word
  return /^\d+$/.test(body)
}
