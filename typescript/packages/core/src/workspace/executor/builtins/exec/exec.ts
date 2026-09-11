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

import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FD_BOTH, FD_CLOSE, FD_STDERR, FD_STDIN, FD_STDOUT } from '../../../../shell/constants.ts'
import { badDescriptorLine, unsupportedDescriptor } from '../../../../shell/descriptors.ts'
import { type Redirect, RedirectKind } from '../../../../shell/types.ts'
import { fsStrerror, isFsError } from '../../../../utils/errors.ts'
import { PathSpec } from '../../../../types.ts'
import { getRedirects } from '../../../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../../../shell/types.ts'
import type { Session } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { createFile } from '../../create.ts'
import { toScope } from '../scope.ts'
import type { EXEC_STREAM_FIELDS } from './constants.ts'
import { CLOSED, OPEN_FOR_READING, TO_STDERR, TO_STDIN, TO_STDOUT } from './constants.ts'
import type { BuiltinCall, Result } from '../types.ts'

/** The `exec` builtin without redirects: bare `exec` is a no-op that
 * succeeds; `exec CMD` has no OS-process referent and is refused. */
export function handleExecCommand(args: string[], _session: Session): Result {
  if (args.length === 0)
    return [null, new IOResult(), new ExecutionNode({ command: 'exec', exitCode: 0 })]
  const err = new TextEncoder().encode(
    `mirage: exec: ${args[0] ?? ''}: process replacement is not supported ` +
      '(no OS process to replace)\n',
  )
  return [
    null,
    new IOResult({ exitCode: 2, stderr: err }),
    new ExecutionNode({ command: 'exec', exitCode: 2, stderr: err }),
  ]
}

/** bash's line for a redirect target it could not open. */
function errorLine(label: string, err: unknown): Uint8Array {
  const strerror = isFsError(err) ? (fsStrerror(err) ?? '') : ''
  return new TextEncoder().encode(strerror !== '' ? `${label}: ${strerror}\n` : `${label}\n`)
}

/** The shell-attributed refusal of an `exec` redirect line; the line is
 * null once it was written where the line's own stderr redirect pointed,
 * and `out` carries it when that redirect pointed at the terminal's
 * stdout. */
function execFailure(line: Uint8Array | null, out: Uint8Array | null = null): Result {
  return [
    out,
    new IOResult({ exitCode: 1, stderr: line }),
    new ExecutionNode({ command: 'exec', exitCode: 1, ...(line !== null ? { stderr: line } : {}) }),
  ]
}

/**
 * What a descriptor points at right now, named so a dup can copy it: a
 * path with its append flag, `CLOSED`, or one of the terminal's own
 * streams (`&0`, `&1`, `&2`). The terminal streams are named rather than
 * left as null because a dup copies the *target*, not the role: after
 * `exec 1>&2`, fd 1 is the terminal's stderr whatever fd 2 is later
 * pointed at, and `exec 2>&1` after that puts stderr back on the
 * terminal's stderr, as bash does. Stdin is always the read end, so a
 * stream bound to it (`exec 1>&0`) has nowhere to write.
 */
/**
 * The bytes a read through a read-open stream yields: the file an
 * `OPEN_FOR_READING` identity names, from its start, since mirage keeps
 * no offset on a descriptor (bash's second read through the same end
 * would be at EOF). A file gone since `exec` opened it reads empty, where
 * bash's still-open end would keep the old bytes.
 */
export async function readOpenSource(dispatch: DispatchFn, identity: string): Promise<Uint8Array> {
  const scope = toScope(identity.slice(OPEN_FOR_READING.length))
  try {
    const [data] = await dispatch('read', scope)
    return await materialize(data as ByteSource)
  } catch (err) {
    if (!isFsError(err)) throw err
    return new Uint8Array()
  }
}

function identity(session: Session, fd: number): [string, boolean] {
  // fd 0 is its own read end unless an `exec` rebound it: closed, or a
  // writing stream's identity (`exec 0<&1`), which a later dup from fd 0
  // copies as bash's does.
  if (fd === FD_STDIN) return [session.execStdinIdentity ?? TO_STDIN, false]
  if (fd === FD_STDERR) return [session.execStderr ?? TO_STDERR, session.execStderrAppend]
  return [session.execStdout ?? TO_STDOUT, session.execStdoutAppend]
}

/** Point a writing stream at an identity. A stream on its own terminal
 * end is stored as null, the undiverted state every reader of
 * `execStdout`/`execStderr` already knows. */
function bind(session: Session, fd: number, id: string, append: boolean): void {
  if (fd === FD_STDERR) {
    session.execStderr = id === TO_STDERR ? null : id
    session.execStderrAppend = append
  } else {
    session.execStdout = id === TO_STDOUT ? null : id
    session.execStdoutAppend = append
  }
}

/**
 * Deliver one stream's bytes where its binding points: to the terminal's
 * stdout, to the terminal's stderr, into a file, or nowhere. Returns the
 * bytes for each terminal stream and whether the write failed: a stream
 * bound to stdin (`exec 1>&0`) or to a file's read end (`exec 1<f`) cannot
 * be written, which is bash's `write error: Bad file descriptor`.
 */
async function route(
  dispatch: DispatchFn,
  session: Session,
  binding: string | null,
  data: Uint8Array,
  own: string,
): Promise<[Uint8Array | null, Uint8Array | null, boolean]> {
  const target = binding ?? own
  if (target === TO_STDOUT) return [data, null, false]
  if (target === TO_STDERR) return [null, data, false]
  if (target === TO_STDIN || target.startsWith(OPEN_FOR_READING)) return [null, null, true]
  if (target !== CLOSED) await appendTo(dispatch, session, target, data)
  return [null, null, false]
}

type StreamBindings = Pick<Session, (typeof EXEC_STREAM_FIELDS)[number]>

function bindingsOf(session: Session): StreamBindings {
  return {
    execStdout: session.execStdout,
    execStdoutAppend: session.execStdoutAppend,
    execStderr: session.execStderr,
    execStderrAppend: session.execStderrAppend,
    execStdin: session.execStdin,
    execStdinUnreadable: session.execStdinUnreadable,
    execStdinIdentity: session.execStdinIdentity,
  }
}

/**
 * Undo a redirect list that failed part-way, the way bash does: it keeps
 * the side effect of opening each earlier target (`exec >f </missing`
 * leaves an empty `f`) but puts every descriptor back where it stood
 * before the line, so an `echo` after it still reaches the terminal. The
 * diagnostic itself goes through the descriptors as they stood at the
 * failure, which is why `exec 2>e </missing` writes it into `e` and
 * `exec 2>&1 </missing` prints it on stdout.
 */
async function rollBack(
  dispatch: DispatchFn,
  session: Session,
  saved: StreamBindings,
  err: Uint8Array,
): Promise<Result> {
  const partial = session.execStderr
  Object.assign(session, saved)
  const [out, errBytes] = await route(dispatch, session, partial, err, TO_STDERR)
  return execFailure(errBytes, out)
}

function scopeOf(target: unknown): PathSpec {
  return typeof target === 'string' ? toScope(target) : (target as PathSpec)
}

/**
 * Point the shell's own streams at files for the rest of the shell. `exec
 * > file` diverts later stdout, `2> file` stderr, `< file` stdin, `>>`
 * appends; `2>&1`/`>&2` copy one target onto the other; `>&-` closes.
 * The output file is opened now, as bash opens it at exec time. A
 * descriptor above 2 (`exec 3>f`, `exec 3>&-`) is refused with `3: Bad
 * file descriptor`: the shell has no descriptor table, and the old
 * fall-through aliased it onto stdout, which is what `exec 3>&-` closed.
 */
export async function installExecRedirects(
  dispatch: DispatchFn,
  session: Session,
  redirects: Redirect[],
): Promise<Result> {
  const badFd = unsupportedDescriptor(redirects)
  if (badFd !== null) return execFailure(badDescriptorLine(badFd))
  const saved = bindingsOf(session)
  const err = await install(dispatch, session, redirects)
  if (err === null)
    return [null, new IOResult(), new ExecutionNode({ command: 'exec', exitCode: 0 })]
  return rollBack(dispatch, session, saved, err)
}

/** Bind the redirects onto the session's streams, in line order. Returns
 * the diagnostic of the first redirect that fails, with every earlier one
 * still bound, which is the state bash reports from. */
async function install(
  dispatch: DispatchFn,
  session: Session,
  redirects: Redirect[],
): Promise<Uint8Array | null> {
  for (const r of redirects) {
    if (r.kind === RedirectKind.AMBIGUOUS) {
      const word = r.target instanceof PathSpec ? r.target.rawPath : String(r.target)
      return new TextEncoder().encode(`${word}: ambiguous redirect\n`)
    }
    if (typeof r.target === 'number') {
      // Keyed on the descriptor claimed, not the operator's direction:
      // `2<&-` closes stderr and `0>&-` stdin, as in bash. A dup of a
      // descriptor onto itself changes nothing, so `0<&0` keeps the file
      // an earlier `exec <f` bound; another descriptor onto stdin
      // restores the ambient input.
      if (r.fd === FD_STDIN) {
        // A closed stdin, or a writing stream dup'd onto it (`0<&1`), has
        // nothing to read: the next reader gets EBADF, as bash's does,
        // until `exec < file` binds a file again. A dup of stdin onto
        // itself keeps the file an earlier `exec <f` bound, and so does a
        // dup from a descriptor that itself holds stdin's read end (`exec
        // 1<&0; exec 0<&1`), which bash reads from as before. Not
        // modelled: a stdin rebound between the two dups, which bash's fd
        // 1 would still hold the old end of.
        if (r.target === FD_CLOSE) {
          session.execStdin = null
          session.execStdinUnreadable = true
          session.execStdinIdentity = CLOSED
          continue
        }
        // A dup onto itself changes nothing, a closed descriptor's
        // included (`exec 0<&-; exec 0<&0`).
        if (r.target === FD_STDIN) continue
        const source = identity(session, r.target)[0]
        if (source === CLOSED) return badDescriptorLine(r.target)
        if (source === TO_STDIN) {
          session.execStdinUnreadable = false
          session.execStdinIdentity = null
        } else if (source.startsWith(OPEN_FOR_READING)) {
          // The descriptor holds a file's read end (`exec 1<f`): fd 0
          // takes the same end, read from the file's start, and a later
          // dup from fd 0 copies it on.
          session.execStdin = await readOpenSource(dispatch, source)
          session.execStdinUnreadable = false
          session.execStdinIdentity = source
        } else {
          session.execStdin = null
          session.execStdinUnreadable = true
          session.execStdinIdentity = source
        }
      } else if (r.target === FD_CLOSE) {
        bind(session, r.fd, CLOSED, false)
      } else if (r.target === r.fd) {
        // `exec 1>&1` on a closed fd 1 is bash's no-op too.
      } else {
        const [id, append] = identity(session, r.target)
        // A dup from a closed descriptor is refused, as bash's `exec 0<&-;
        // exec 1<&0` is with `0: Bad file descriptor`.
        if (id === CLOSED) return badDescriptorLine(r.target)
        bind(session, r.fd, id, append)
      }
      continue
    }
    const scope = scopeOf(r.target)
    if (r.kind === RedirectKind.STDIN) {
      let data: unknown
      try {
        ;[data] = await dispatch('read', scope)
      } catch (err) {
        if (!isFsError(err)) throw err
        return errorLine(scope.rawPath, err)
      }
      if (r.fd !== FD_STDIN) {
        // `exec 1<f`: the stream holds the file's read end, so a write to
        // it fails as one to stdin's end does (`echo: write error: Bad
        // file descriptor`), a dup onto fd 0 (`exec 0<&1`) reads the
        // file, and so does a transient `<&1`.
        bind(session, r.fd, OPEN_FOR_READING + scope.virtual, false)
        continue
      }
      // fd 0 holds the file's read end, and says so: a dup from it (`exec
      // 1<&0`) keeps the file even after `exec 0<&-`, as bash's copied
      // descriptor does.
      session.execStdin = await materialize(data as ByteSource)
      session.execStdinUnreadable = false
      session.execStdinIdentity = OPEN_FOR_READING + scope.virtual
      continue
    }
    const path = scope.virtual
    try {
      if (await openTarget(dispatch, session, scope, r.append)) session.execOpened.add(path)
    } catch (err) {
      if (!isFsError(err)) throw err
      return errorLine(scope.rawPath, err)
    }
    if (r.fd === FD_STDIN) {
      // `exec 0>f`: fd 0 holds the file's write end, so a read fails with
      // EBADF, a later dup from it (`exec 1>&0`) writes there, and so does
      // a transient `>&0`.
      session.execStdin = null
      session.execStdinUnreadable = true
      session.execStdinIdentity = path
      continue
    }
    const streams =
      r.fd === FD_BOTH ? ['stdout', 'stderr'] : r.fd === FD_STDERR ? ['stderr'] : ['stdout']
    for (const stream of streams) {
      if (stream === 'stderr') {
        session.execStderr = path
        session.execStderrAppend = r.append
      } else {
        session.execStdout = path
        session.execStdoutAppend = r.append
      }
    }
  }
  return null
}

/**
 * Open an `exec` redirect target, the way bash does at `exec` time:
 * truncating creates the file empty, appending creates it only when it
 * is not already there so an existing one keeps its bytes. Either way
 * the file exists before the next statement runs, which is what makes
 * `exec >> new; test -e new` succeed with nothing written. Returns
 * whether it was written, which is what marks the target opened.
 */
async function openTarget(
  dispatch: DispatchFn,
  session: Session,
  scope: PathSpec,
  append: boolean,
): Promise<boolean> {
  if (append) {
    try {
      await dispatch('stat', scope)
      return false
    } catch (err) {
      if (!isFsError(err)) throw err
    }
  }
  await createFile(dispatch, session, scope, new Uint8Array(0))
  return true
}

/**
 * Send one statement's output where the shell's `exec` bindings point. A
 * stream bound to a file is appended to it (the first write to each
 * target having truncated it at `exec` time), one bound to the other
 * terminal stream crosses over (`exec 2>&1` puts stderr on stdout), a
 * closed one is dropped, and one bound to stdin fails with bash's `write
 * error: Bad file descriptor`, which is reported on stderr through
 * stderr's own binding and makes the statement's status 1. `command` is
 * the statement's recorded line; its first word names the writer in a
 * write error. Returns the stdout that should still bubble up (null once
 * nothing is left for the terminal).
 */
/**
 * Whether a statement sends its own stdout to stderr (`>&2`): what tells
 * a writer's failed write from a lost diagnostic under an unwritable
 * stderr. bash's `echo hi >&2` reports 1 when the write fails, while a
 * program whose diagnostic could not be delivered keeps its own status.
 */
export function stdoutToStderr(node: TSNodeLike): boolean {
  if (node.type !== NT.REDIRECTED_STATEMENT) return false
  const [, redirects] = getRedirects(node)
  return redirects.some((r) => r.target === FD_STDERR && (r.fd === FD_STDOUT || r.fd === FD_BOTH))
}

export async function divertStatement(
  dispatch: DispatchFn,
  session: Session,
  stdout: Uint8Array | null,
  io: IOResult,
  command: string,
  stdoutDiverted = false,
): Promise<Uint8Array | null> {
  const outParts: Uint8Array[] = []
  const errParts: Uint8Array[] = []
  let failed = false
  if (stdout !== null && stdout.byteLength > 0) {
    const [out, err, unwritable] = await route(
      dispatch,
      session,
      session.execStdout,
      stdout,
      TO_STDOUT,
    )
    if (out !== null) outParts.push(out)
    if (err !== null) errParts.push(err)
    failed = unwritable
  }
  let stderr = await materialize(io.stderr)
  if (failed) {
    const first = command.trim().split(/\s+/)[0]
    const name = first === undefined || first === '' ? 'bash' : first
    stderr = joinBytes([
      stderr,
      new TextEncoder().encode(`${name}: write error: Bad file descriptor\n`),
    ])
    io.exitCode = 1
  }
  if (stderr.byteLength > 0) {
    const [out, err, unwritable] = await route(
      dispatch,
      session,
      session.execStderr,
      stderr,
      TO_STDERR,
    )
    if (out !== null) outParts.push(out)
    if (err !== null) errParts.push(err)
    // The statement's own output was what could not be written, so the
    // write error is its failure (bash's `echo hi >&2` under `exec 2>&0`
    // reports 1). A diagnostic that could not be delivered leaves the
    // status alone: GNU find still exits 0 after `-exec nosuch`, ls keeps
    // its 2 and cat its 1, since the failed write is of a message, not of
    // the work.
    if (unwritable && stdoutDiverted && io.exitCode === 0) io.exitCode = 1
  }
  io.stderr = errParts.length > 0 ? joinBytes(errParts) : null
  return outParts.length > 0 ? joinBytes(outParts) : null
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

async function appendTo(
  dispatch: DispatchFn,
  session: Session,
  target: string,
  data: Uint8Array,
): Promise<void> {
  if (target === CLOSED) return
  const scope = toScope(target)
  let existing: Uint8Array = new Uint8Array(0)
  try {
    const [prior] = await dispatch('read', scope)
    existing = await materialize(prior as ByteSource)
  } catch (err) {
    if (!isFsError(err)) throw err
  }
  const combined: Uint8Array<ArrayBuffer> = new Uint8Array(existing.byteLength + data.byteLength)
  combined.set(existing, 0)
  combined.set(data, existing.byteLength)
  try {
    await dispatch('write', scope, [combined])
    session.execOpened.add(target)
  } catch (err) {
    if (!isFsError(err)) throw err
  }
}

/**
 * The `exec` arm. The redirect-only form is intercepted where redirects
 * are applied; a bare `exec` here has none, and `exec cmd` is the
 * process-replacement form this refuses.
 */
export function execBuiltin(call: BuiltinCall): Promise<Result> {
  return Promise.resolve(handleExecCommand([...call.argv.args], call.session))
}
