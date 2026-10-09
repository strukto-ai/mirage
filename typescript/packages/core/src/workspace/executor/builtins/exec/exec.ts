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

import { SharedInput, share } from '../../../../io/async_line_iterator.ts'
import { IOResult, materialize } from '../../../../io/types.ts'
import type { ByteSource } from '../../../../io/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FD_BOTH, FD_CLOSE, FD_STDERR, FD_STDIN, FD_STDOUT } from '../../../../shell/constants.ts'
import {
  FileDescription,
  FileInput,
  Inherited,
  badDescriptorLine,
  unsupportedDescriptor,
} from '../../../../shell/descriptors.ts'
import { Channel } from '../../../../shell/console/index.ts'
import { recordStatus, type Written } from '../../statement.ts'
import { type Redirect, RedirectKind } from '../../../../shell/types.ts'
import { fsStrerror, isFsError, isMissingPath } from '../../../../errors/fs.ts'
import { PathSpec } from '../../../../types.ts'
import { getRedirects } from '../../../../shell/helpers.ts'
import { NodeType as NT, type TSNodeLike } from '../../../../shell/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { createFile, writeDescription } from '../../create.ts'
import { toScope } from '../scope.ts'
import type { EXEC_STREAM_FIELDS } from './constants.ts'
import {
  CLOSED,
  OPEN_FOR_READ_WRITE,
  OPEN_FOR_READING,
  TO_STDERR,
  TO_STDIN,
  TO_STDOUT,
} from './constants.ts'
import type { BuiltinCall, Result } from '../types.ts'
import { concat } from '../../../../io/cachable_iterator.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { runAsProgram } from '../../../../context/session_context.ts'
import { ExitSignal } from '../../../../shell/errors.ts'
import { shellJoin } from '../../../../shell/join.ts'
import type { ExecuteFn } from '../../../expand/node.ts'
import type { MountRegistry } from '../../../mount/registry.ts'
import { programHead } from '../../find_action_dispatch.ts'
import { clearTraps } from '../../traps.ts'
import { builtinError } from '../shared.ts'
import { EXEC_USAGE } from './constants.ts'
import { scanOptions } from '../getopt.ts'

/**
 * The `exec` builtin without redirects. Bare `exec` is a no-op that
 * succeeds. `exec CMD ...` runs CMD as a program and ends the shell with its
 * status, as bash replaces the shell with it: the rest of the scope (the
 * line at top level, a subshell, a substitution, a nested shell) does not
 * run, and the replaced shell's actions go with it, EXIT included. A head no
 * program answers to (a builtin of the shell's own, a function, nothing) is
 * `exec: NAME: not found`, which ends the shell with 127 and runs its EXIT
 * action, as bash's does. `-c` runs CMD with an empty environment; `-a` and
 * `-l` name an argv[0] that mirage's programs do not read, and are refused.
 * The redirect-only form (`exec > file`) never reaches here: it is a
 * redirected statement, handled where redirects are applied. Mirrors Python.
 */
export async function handleExecCommand(
  args: string[],
  session: SessionState,
  executeFn: ExecuteFn | null = null,
  registry: MountRegistry | null = null,
  stdin: ByteSource | null = null,
): Promise<Result> {
  const scan = scanOptions(args, 'acl')
  const refused = scan.letters.find((f) => f === 'a' || f === 'l')
  if (scan.bad !== null || refused !== undefined) {
    const err =
      scan.bad !== null
        ? concat([builtinError('exec', `${scan.bad}: invalid option`), encodeText(EXEC_USAGE)])
        : encodeText(`mirage: exec: -${refused ?? ''}: not supported\n`)
    return [
      null,
      new IOResult({ exitCode: 2, stderr: err }),
      new ExecutionNode({ command: 'exec', exitCode: 2, stderr: err }),
    ]
  }
  const words = scan.operands
  const head = words[0]
  if (head === undefined || executeFn === null || registry === null)
    return [null, new IOResult(), new ExecutionNode({ command: 'exec', exitCode: 0 })]
  const [missing, shadowed] = await programHead(head, session, registry, session.cwd, null)
  if (missing) throw new ExitSignal(127, builtinError('exec', `${head}: not found`))
  const line =
    (scan.letters.includes('c') ? 'env -i ' : '') + (shadowed ? 'command ' : '') + shellJoin(words)
  clearTraps(session)
  const io = await runAsProgram(session, () =>
    executeFn(line, { sessionId: session.sessionId, stdin }),
  )
  const stdout = await materialize(io.stdout)
  const stderr = await io.materializeStderr()
  const replaced = new ExitSignal(io.exitCode, stderr, stdout)
  replaced.replaced = head
  replaced.unrouted = true
  throw replaced
}

/** bash's line for a redirect target it could not open. */
function errorLine(label: string, err: unknown): Uint8Array {
  const strerror = isFsError(err) ? (fsStrerror(err) ?? '') : ''
  return encodeText(strerror !== '' ? `${label}: ${strerror}\n` : `${label}\n`)
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
 * stream bound to it (`exec 1>&0`) has nowhere to write, and fd 0 names its
 * own read end unless an `exec` rebound it (`exec 0<&1`), which a later dup
 * from fd 0 copies.
 */
function identity(session: SessionState, fd: number): [string, boolean] {
  if (fd > FD_STDERR) {
    const descriptor = session.descriptors.get(fd)
    return descriptor === undefined ? [CLOSED, false] : [descriptor.identity, descriptor.append]
  }
  if (fd === FD_STDIN) return [session.execStdinIdentity ?? TO_STDIN, false]
  if (fd === FD_STDERR) return [session.execStderr ?? TO_STDERR, session.execStderrAppend]
  return [session.execStdout ?? TO_STDOUT, session.execStdoutAppend]
}

/** A new descriptor on the read end a descriptor holds, as a dup makes
 * one: it shares the offset, so a read through either moves both. Null
 * when the descriptor holds no file's read end. */
function readEnd(
  session: SessionState,
  fd: number,
  stdin: ByteSource | null = null,
): SharedInput | null {
  if (fd === FD_STDIN && stdin !== null) {
    const source = share(stdin)
    return source instanceof SharedInput ? source : null
  }
  if (fd > FD_STDERR) return session.descriptors.get(fd)?.source ?? null
  const held =
    fd === FD_STDIN
      ? session.execStdin
      : fd === FD_STDERR
        ? session.execStderrInput
        : session.execStdoutInput
  return held?.dup() ?? null
}

/** Point a writing stream at an identity. A stream on its own terminal
 * end is stored as null, the undiverted state every reader of
 * `execStdout`/`execStderr` already knows. `input` is the file's read
 * end, for an `OPEN_FOR_READING` identity. */
function bind(
  session: SessionState,
  fd: number,
  id: string,
  append: boolean,
  input: SharedInput | null = null,
  file: FileDescription | null = null,
  stream: Inherited | null = null,
): void {
  session.descriptors.set(fd, {
    identity: id,
    append,
    source: input,
    file: input instanceof FileInput ? input.description : file,
    stream,
  })
  if (fd > FD_STDERR) return
  if (fd === FD_STDIN) {
    session.execStdin = input
    session.execStdinIdentity = id === TO_STDIN ? null : id
    session.execStdinUnreadable = input === null && id !== TO_STDIN
  } else if (fd === FD_STDERR) {
    session.execStderr = id === TO_STDERR ? null : id
    session.execStderrAppend = append
    session.execStderrInput = input
  } else {
    session.execStdout = id === TO_STDOUT ? null : id
    session.execStdoutAppend = append
    session.execStdoutInput = input
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
  session: SessionState,
  binding: string | null,
  data: Uint8Array,
  own: string,
): Promise<[Uint8Array | null, Uint8Array | null, boolean]> {
  const target = binding ?? own
  const descriptor = session.descriptors.get(own === TO_STDOUT ? 1 : 2)
  if (descriptor?.file != null && descriptor.identity === target) {
    await writeDescription(dispatch, session, descriptor.file, data)
    return [null, null, false]
  }
  if (target.startsWith(OPEN_FOR_READ_WRITE)) {
    const source = own === TO_STDOUT ? session.execStdoutInput : session.execStderrInput
    if (source instanceof FileInput) {
      await writeDescription(dispatch, session, source.description, data)
      return [null, null, false]
    }
  }
  if (target === TO_STDOUT) return [data, null, false]
  if (target === TO_STDERR) return [null, data, false]
  if (target === TO_STDIN || target.startsWith(OPEN_FOR_READING)) return [null, null, true]
  if (target !== CLOSED) await appendTo(dispatch, session, target, data)
  return [null, null, false]
}

type StreamBindings = Pick<SessionState, (typeof EXEC_STREAM_FIELDS)[number] | 'descriptors'>

function bindingsOf(session: SessionState): StreamBindings {
  return {
    descriptors: new Map(session.descriptors),
    execStdout: session.execStdout,
    execStdoutAppend: session.execStdoutAppend,
    execStdoutInput: session.execStdoutInput,
    execStderr: session.execStderr,
    execStderrAppend: session.execStderrAppend,
    execStderrInput: session.execStderrInput,
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
  session: SessionState,
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
 * The output file is opened now, as bash opens it at exec time. Numbered
 * descriptors use the same bindings and share open descriptions when duplicated,
 * and a copy of a terminal stream stays that stream when the shell later
 * rebinds its own (`exec 3>&1; exec >f`).
 */
export async function installExecRedirects(
  dispatch: DispatchFn,
  session: SessionState,
  redirects: Redirect[],
  stdin: ByteSource | null = null,
  expand?: (redirect: Redirect) => Promise<Redirect>,
): Promise<Result> {
  const badFd = unsupportedDescriptor(redirects)
  if (badFd !== null) return execFailure(badDescriptorLine(badFd))
  const saved = bindingsOf(session)
  let err: Uint8Array | null
  try {
    err = await install(dispatch, session, redirects, stdin, expand)
  } catch (error) {
    Object.assign(session, saved)
    throw error
  }
  if (err === null)
    return [null, new IOResult(), new ExecutionNode({ command: 'exec', exitCode: 0 })]
  return rollBack(dispatch, session, saved, err)
}

/** Bind the redirects onto the session's streams, in line order. Returns
 * the diagnostic of the first redirect that fails, with every earlier one
 * still bound, which is the state bash reports from. */
async function install(
  dispatch: DispatchFn,
  session: SessionState,
  redirects: readonly Redirect[],
  stdin: ByteSource | null,
  expand?: (redirect: Redirect) => Promise<Redirect>,
): Promise<Uint8Array | null> {
  for (const raw of redirects) {
    const redirect = expand === undefined ? raw : await expand(raw)
    const error = await installDescriptor(dispatch, session, redirect, stdin)
    if (error !== null) return error
  }
  return null
}

async function installDescriptor(
  dispatch: DispatchFn,
  session: SessionState,
  redirect: Redirect,
  stdin: ByteSource | null,
): Promise<Uint8Array | null> {
  const { fd, target } = redirect
  if (redirect.kind === RedirectKind.AMBIGUOUS) {
    const word = target instanceof PathSpec ? target.rawPath : String(target)
    return encodeText(`${word}: ambiguous redirect\n`)
  }
  if (redirect.kind === RedirectKind.HEREDOC || redirect.kind === RedirectKind.HERESTRING) {
    const data = String(target) + (redirect.kind === RedirectKind.HERESTRING ? '\n' : '')
    bind(session, fd, OPEN_FOR_READING, false, new SharedInput(encodeText(data)))
    return null
  }
  if (typeof target === 'number') {
    if (target === fd) return null
    const [id, append] =
      target === FD_CLOSE ? ([CLOSED, false] as const) : identity(session, target)
    if (id === CLOSED && target !== FD_CLOSE) return badDescriptorLine(target)
    const original = session.descriptors.get(target)
    let stream = original?.stream ?? null
    if (
      stream === null &&
      fd > FD_STDERR &&
      (original?.file ?? null) === null &&
      (id === TO_STDOUT || id === TO_STDERR)
    )
      stream = new Inherited(session.terminal, id === TO_STDOUT ? Channel.STDOUT : Channel.STDERR)
    bind(session, fd, id, append, readEnd(session, target, stdin), original?.file ?? null, stream)
    return null
  }
  const scope = scopeOf(target)
  try {
    if (redirect.kind === RedirectKind.STDIN || redirect.kind === RedirectKind.READWRITE) {
      let data: ByteSource | null
      try {
        data = (await dispatch('read', scope))[0] as ByteSource | null
      } catch (error) {
        if (redirect.kind !== RedirectKind.READWRITE || !isMissingPath(error)) throw error
        data = new Uint8Array()
      }
      const bytes = await materialize(data)
      if (redirect.kind === RedirectKind.READWRITE) {
        await createFile(dispatch, session, scope, new Uint8Array(), true)
        const file = new FileDescription(scope)
        file.opened = true
        file.source = new FileInput(file, bytes)
        bind(session, fd, OPEN_FOR_READ_WRITE + scope.virtual, false, file.source)
      } else bind(session, fd, OPEN_FOR_READING + scope.virtual, false, new SharedInput(bytes))
    } else {
      await createFile(dispatch, session, scope, new Uint8Array(), redirect.append)
      const file = new FileDescription(scope, redirect.append)
      file.opened = true
      for (const claimed of fd === FD_BOTH ? [1, 2] : [fd])
        bind(session, claimed, scope.virtual, redirect.append, null, file)
    }
  } catch (error) {
    if (!isFsError(error)) throw error
    return errorLine(scope.rawPath, error)
  }
  return null
}

/**
 * Whether a statement sends its own stdout to stderr (`>&2`): what tells
 * a writer's failed write from a lost diagnostic under an unwritable
 * stderr. bash's `echo hi >&2` reports 1 when the write fails, while a
 * program whose diagnostic could not be delivered keeps its own status.
 */
function stdoutToStderr(node: TSNodeLike): boolean {
  if (node.type !== NT.REDIRECTED_STATEMENT) return false
  const [, redirects] = getRedirects(node)
  return redirects.some((r) => r.target === FD_STDERR && (r.fd === FD_STDOUT || r.fd === FD_BOTH))
}

/**
 * Send one statement's output where the shell's `exec` bindings point.
 * Called after each statement of a shell's own loop; with no `exec`
 * redirect in force (or no dispatcher) the output passes through. A
 * stream bound to a file is appended to it (the first write to each
 * target having truncated it at `exec` time), one bound to the other
 * terminal stream crosses over (`exec 2>&1` puts stderr on stdout), a
 * closed one is dropped, and one bound to stdin fails with bash's `write
 * error: Bad file descriptor`, which is reported on stderr through
 * stderr's own binding and makes the statement's status 1, which `$?`
 * shows. An unwritable stderr fails only a statement that sent its own
 * stdout there (`>&2`); a lost diagnostic leaves the status the command
 * earned. `command` is the statement's recorded line; its first word names
 * the writer in a write error. `written` is the statement's output in
 * order; what went to the terminal through a copy keeps its place. Returns
 * what is left for the terminal, in the order it was written. Mirrors
 * Python's divert_statement.
 */
export async function divertStatement(
  dispatch: DispatchFn | undefined,
  session: SessionState,
  written: readonly Written[],
  io: IOResult,
  statement: TSNodeLike,
  command: string,
): Promise<readonly Written[]> {
  if (dispatch === undefined || (session.execStdout === null && session.execStderr === null))
    return written
  const earned = io.exitCode
  const rest: Written[] = []
  let failed = false
  let unwritable = false
  for (const [channel, data, kept] of runs(written)) {
    if (kept) rest.push([channel, data, true])
    else if (await routed(dispatch, session, channel, data, rest)) {
      failed ||= channel === Channel.STDOUT
      unwritable ||= channel === Channel.STDERR
    }
  }
  if (failed) {
    const first = command.trim().split(/\s+/)[0]
    const name = first === undefined || first === '' ? 'bash' : first
    io.exitCode = 1
    const line = encodeText(`${name}: write error: Bad file descriptor\n`)
    await routed(dispatch, session, Channel.STDERR, line, rest)
  } else if (unwritable && io.exitCode === 0 && stdoutToStderr(statement)) {
    io.exitCode = 1
  }
  if (io.exitCode !== earned) recordStatus(session, io.exitCode)
  return rest
}

/** Adjacent chunks of one stream and one kind joined, in order. */
function runs(written: readonly Written[]): Written[] {
  const out: Written[] = []
  for (const [channel, data, kept] of written) {
    const last = out[out.length - 1]
    if (last?.[0] === channel && last[2] === kept)
      out[out.length - 1] = [channel, concat([last[1], data]), kept]
    else out.push([channel, data, kept])
  }
  return out
}

/** Route one run of output through its stream's binding, adding what
 * reaches the terminal to `rest`; true when the write failed. Mirrors
 * Python's _routed. */
async function routed(
  dispatch: DispatchFn,
  session: SessionState,
  channel: Channel,
  data: Uint8Array,
  rest: Written[],
): Promise<boolean> {
  const stdout = channel === Channel.STDOUT
  const binding = stdout ? session.execStdout : session.execStderr
  const [out, err, failed] = await route(
    dispatch,
    session,
    binding,
    data,
    stdout ? TO_STDOUT : TO_STDERR,
  )
  if (out !== null) rest.push([Channel.STDOUT, out, false])
  if (err !== null) rest.push([Channel.STDERR, err, false])
  return failed
}

async function appendTo(
  dispatch: DispatchFn,
  session: SessionState,
  target: string,
  data: Uint8Array,
): Promise<void> {
  if (target === CLOSED) return
  const scope = toScope(target)
  try {
    await dispatch('append', scope, [data])
  } catch (err) {
    if (!isFsError(err)) throw err
  }
}

/**
 * The `exec` arm. The redirect-only form is intercepted where redirects
 * are applied; a bare `exec` here has none, and `exec cmd` runs the
 * command and ends the shell.
 */
export function execBuiltin(call: BuiltinCall): Promise<Result> {
  return handleExecCommand(
    [...call.argv.args],
    call.context.session,
    call.executeFn,
    call.registry,
    call.stdin,
  )
}
