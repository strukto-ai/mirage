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

import { fsStrerror, isFsError } from '../../utils/errors.ts'
import { stripSlash } from '../../utils/slash.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { type Redirect, RedirectKind } from '../../shell/types.ts'
import { PathSpec } from '../../types.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { Session } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import type { ExecuteNodeFn } from './jobs.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

const TO_STDOUT = Symbol('stdout')
const TO_STDERR = Symbol('stderr')
type FdDest = typeof TO_STDOUT | typeof TO_STDERR | string

/**
 * Handle all redirect patterns: >, >>, <, 2>, 2>&1, &>, >&2, <<<.
 *
 * File-descriptor routing follows bash's left-to-right fd table: each
 * redirect updates where fd1/fd2 point at that moment, so
 * `cmd > f 2>&1` sends both streams to f while `cmd 2>&1 > f` sends
 * stderr to the original stdout. Output files are created (and
 * truncated unless appending) when the redirect is processed, even if
 * the stream ends up empty — including the command-less `> file` form
 * (command is null).
 *
 * A redirect target that cannot be opened is a shell error, not a command
 * error — on both the `<` read and the `>` write side. bash reports it itself
 * and never names the command, so both paths render `<target>: <strerror>`
 * (see `redirectErrorLine`) and the rest of the line keeps running. bash also
 * stops processing redirects at the first failed open, so later targets are
 * left alone: GNU 5.2.37 answers `echo x > /nodir/f > /data/out` with one
 * message and no `/data/out`, while earlier targets keep the empty file their
 * open already created (`echo y > /data/out2 > /nodir/g` leaves `/data/out2`
 * present and empty).
 *
 * Deliberate divergence from bash: when both streams route to the same
 * destination they are concatenated stdout-then-stderr, not temporally
 * interleaved (streams are materialized buffers).
 *
 * Deliberate divergence from bash: because output files are created in a
 * second pass (after the command runs), an output redirect that precedes a
 * failing `<` is not truncated — bash processes redirects strictly left to
 * right, so `> out < missing` empties `out` before failing. `< missing >
 * out` leaves `out` uncreated on both, which is bash's behavior. For the same
 * reason a command whose `>` target is unwritable has already run here, while
 * bash fails at open time and never runs it; the write error and exit 1 are
 * reported either way.
 */
export async function handleRedirect(
  executeNode: ExecuteNodeFn,
  dispatch: DispatchFn,
  command: TSNodeLike | null,
  redirects: readonly Redirect[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  let cmdStdin: ByteSource | null = stdin

  for (const r of redirects) {
    if (r.kind === RedirectKind.STDIN) {
      const scope = ensureScope(r.target)
      let data: unknown
      try {
        ;[data] = await dispatch('read', scope)
      } catch (err) {
        if (!isFsError(err)) throw err
        return redirectFailure(scope, err)
      }
      cmdStdin = data as ByteSource | null
    } else if (r.kind === RedirectKind.HEREDOC) {
      cmdStdin = typeof r.target === 'string' ? encodeText(r.target) : (r.target as ByteSource)
    } else if (r.kind === RedirectKind.HERESTRING) {
      const text = r.target
      if (typeof text === 'string') {
        let t = text
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
          t = t.slice(1, -1)
        }
        cmdStdin = encodeText(`${t}\n`)
      } else {
        cmdStdin = text as ByteSource
      }
    }
  }

  let stdoutData: Uint8Array
  let stderrData: Uint8Array
  let io: IOResult
  if (command === null) {
    stdoutData = new Uint8Array()
    stderrData = new Uint8Array()
    io = new IOResult({ exitCode: 0 })
  } else {
    const [stdout, execIo] = await executeNode(command, session, cmdStdin, callStack)
    io = execIo
    stdoutData =
      ((await applyBarrier(stdout, io, BarrierPolicy.VALUE)) as Uint8Array | null) ??
      new Uint8Array()
    stderrData = await materialize(io.stderr)
  }

  let fd1: FdDest = TO_STDOUT
  let fd2: FdDest = TO_STDERR
  const fileBufs = new Map<string, Uint8Array>()
  const fileScopes = new Map<string, PathSpec>()

  for (const r of redirects) {
    if (
      r.kind === RedirectKind.STDIN ||
      r.kind === RedirectKind.HEREDOC ||
      r.kind === RedirectKind.HERESTRING
    ) {
      continue
    }

    // 2>&1 — fd2 follows wherever fd1 points right now
    if (r.kind === RedirectKind.STDERR_TO_STDOUT && typeof r.target === 'number') {
      fd2 = fd1
      continue
    }

    // >&2 or 1>&2 — fd1 follows wherever fd2 points right now
    if (r.fd === 1 && r.target === 2) {
      fd1 = fd2
      continue
    }

    // other numeric dups (3>&1, ...) are not simulated
    if (typeof r.target === 'number') continue

    const scope = ensureScope(r.target)
    const path = scope.virtual
    fileScopes.set(path, scope)
    if (r.append) {
      if (!fileBufs.has(path)) {
        fileBufs.set(path, await readExisting(dispatch, scope))
      }
    } else {
      fileBufs.set(path, new Uint8Array())
    }

    if (r.fd === -1) {
      // &> / &>>
      fd1 = path
      fd2 = path
    } else if (r.kind === RedirectKind.STDERR) {
      fd2 = path
    } else {
      fd1 = path
    }
  }

  let outStdout: Uint8Array = new Uint8Array()
  let outStderr: Uint8Array = new Uint8Array()
  for (const [data, dest] of [
    [stdoutData, fd1],
    [stderrData, fd2],
  ] as [Uint8Array, FdDest][]) {
    if (dest === TO_STDOUT) {
      outStdout = concat([outStdout, data])
    } else if (dest === TO_STDERR) {
      outStderr = concat([outStderr, data])
    } else {
      fileBufs.set(dest, concat([fileBufs.get(dest) ?? new Uint8Array(), data]))
    }
  }

  for (const [path, data] of fileBufs) {
    const scope = fileScopes.get(path)
    if (scope === undefined) continue
    try {
      await dispatch('write', scope, [data])
      io.writes[path] = data
    } catch (err) {
      if (!isFsError(err)) throw err
      outStderr = concat([outStderr, redirectErrorLine(scope, err)])
      io.exitCode = 1
      break
    }
  }

  io.stderr = outStderr.byteLength > 0 ? outStderr : null
  const execNode = new ExecutionNode({ command: 'redirect', exitCode: io.exitCode })
  const outSource: ByteSource | null = outStdout.byteLength > 0 ? outStdout : null
  return [outSource, io, execNode]
}

/**
 * GNU stderr line for a redirect target that could not be opened.
 *
 * GNU bash 5.2.37 answers both `cat < missing` and `echo x > /nosuchdir/f`
 * with `bash: line 1: <target>: No such file or directory` and exit 1: the
 * error belongs to the shell, not the command, and the rest of the line keeps
 * running (`;` continues, `&&` short-circuits, `||` runs).
 *
 * Deliberate divergence from bash: the `bash: line N:` prefix is dropped, so
 * the line is `<target>: <strerror>`. This matches the house style already
 * set by the other shell-attributed error, `nosuchcmd: command not found`
 * (bash prints `bash: line 1: nosuchcmd: command not found`) — `bash:` is
 * bash's `$0` and mirage is not bash, and `line N` has no meaning for a
 * one-line `Workspace.execute` call.
 *
 * The label is the target's own spelling, never the error's message: backends
 * raise write failures with prose in the message (`parent directory does not
 * exist: /nodir`), which used to reach the user as the path.
 */
function redirectErrorLine(scope: PathSpec, err: unknown): Uint8Array {
  const strerror = fsStrerror(err)
  const label = scope.rawPath
  return new TextEncoder().encode(strerror !== null ? `${label}: ${strerror}\n` : `${label}\n`)
}

/**
 * Shell-attributed IOResult for a `<` source that cannot be read.
 *
 * bash never runs the command and stops processing redirects at the first
 * failure, so this replaces the whole result. Returning an IOResult rather
 * than rethrowing is what keeps the rest of the line alive.
 */
function redirectFailure(scope: PathSpec, err: unknown): Result {
  const io = new IOResult({ exitCode: 1, stderr: redirectErrorLine(scope, err) })
  return [null, io, new ExecutionNode({ command: 'redirect', exitCode: 1 })]
}

async function readExisting(dispatch: DispatchFn, scope: PathSpec): Promise<Uint8Array> {
  try {
    const [existing] = await dispatch('read', scope)
    if (existing instanceof Uint8Array) return existing
  } catch (err) {
    // file doesn't exist yet, or not readable — appending starts fresh and
    // the write that follows reports the real failure as a shell-attributed
    // line. Non-filesystem errors are bugs and still propagate.
    if (!isFsError(err)) throw err
  }
  return new Uint8Array()
}

function ensureScope(target: unknown): PathSpec {
  if (target instanceof PathSpec) return target
  if (typeof target === 'string') return toScope(target)
  return toScope(String(target))
}

function toScope(path: string): PathSpec {
  const lastSlash = path.lastIndexOf('/')
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/'
  return new PathSpec({ resourcePath: stripSlash(path), virtual: path, directory, resolved: true })
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}
