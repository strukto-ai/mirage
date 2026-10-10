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

import type { ExecutionFrame } from '../frame.ts'
import { readFailExitCode } from '../../commands/spec/usage.ts'
import type { SharedInput } from '../../io/async_line_iterator.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import { formatFsError } from '../../errors/render.ts'
import type { ExecutionNode, StatusWriter } from '../types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import {
  ENCLOSING,
  Inherited,
  type Recorder,
  type StreamOwner,
  deliver,
  unreadableStdin,
} from '../../shell/descriptors.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { pipelineTransparent } from '../../shell/node_kind.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { SessionState } from '../session/session.ts'
import { abortedLine, lineStatusWriter } from '../abort.ts'
import { makeAbortError } from '../../utils/abort.ts'

/**
 * Run a test, the left of `&&`/`||` or a negated command where bash ignores
 * `set -e`: nothing it runs exits for a failure, a function body or a
 * subshell included. Mirrors Python's ignoring_errexit.
 */
export async function ignoringErrexit<T>(session: SessionState, fn: () => Promise<T>): Promise<T> {
  const saved = session.errexitIgnored
  session.errexitIgnored = true
  try {
    return await fn()
  } finally {
    session.errexitIgnored = saved
  }
}

/** Whether `set -e` ends the shell after this statement, marking the shell
 * as ending when it does. */
export function errexitActs(node: TSNodeLike, status: number, session: SessionState): boolean {
  const acts =
    status !== 0 &&
    session.shellOptions.errexit === true &&
    !ERREXIT_EXEMPT_TYPES.has(node.type) &&
    !session.errexitImmune &&
    !session.errexitIgnored
  if (acts) session.errexitExiting = true
  return acts
}

/**
 * Record a finished statement's exit status: `$?` and `${PIPESTATUS[@]}`
 * together.
 *
 * The one function every status write goes through, so the two can never
 * disagree. `handlePipe` parks its per-segment statuses on the session,
 * and the boundary that closes the pipeline claims them here; a boundary
 * with nothing parked stamps its own one-element status, which is what a
 * simple command, a function call or a subshell leaves in bash. A
 * *transparent* statement (a group, a loop, a negation, a redirected
 * pipeline: see `pipelineTransparent`) claims what was parked but never
 * overwrites, because bash reports the last pipeline that ran *inside* it
 * (`{ false | true; }` keeps `1 0`).
 */
export function recordStatus(session: SessionState, code: number, transparent = false): void {
  // A statement that settles after the caller was released is an orphan.
  // Its status is nobody's `$?`, and the throw ends the loop that would
  // otherwise run the next statement on a shell nobody is waiting on.
  const lineAbort = abortedLine(session)
  if (lineAbort !== undefined) throw makeAbortError(lineAbort)
  // Whose status this is, so an aborted line puts back only what it
  // overwrote and never a concurrent line's finished result.
  session.statusWriter = lineStatusWriter(session)
  session.lastExitCode = code
  const pending = session.pipeStatusPending
  session.pipeStatusPending = null
  if (pending !== null) session.pipeStatus = pending
  else if (!transparent) session.pipeStatus = [code]
}

/**
 * The status a line found, taken before its first statement runs and
 * put back if the caller aborts the line.
 *
 * An aborted invocation is the caller's outcome, not the shell's, so it
 * must leave `$?` where it was. But the abort lands on one await inside
 * the line, and every statement before that await has already stamped
 * through `recordStatus`. The status write refuses a statement that
 * settles after the caller was released; this is for the ones that
 * landed before it, and only a copy taken before the line can undo them.
 *
 * The three fields travel together because they are one shell fact:
 * `$?`, `${PIPESTATUS[@]}`, and the per-segment statuses a pipeline
 * parked for its boundary to claim. Restoring one without the others
 * would leave a state no bash line produces.
 */
export interface StatusSnapshot {
  lastExitCode: number
  pipeStatus: readonly number[]
  pipeStatusPending: readonly number[] | null
}

/** Capture `$?` and `${PIPESTATUS[@]}` before a line runs. */
export function snapshotStatus(session: SessionState): StatusSnapshot {
  return {
    lastExitCode: session.lastExitCode,
    pipeStatus: session.pipeStatus,
    pipeStatusPending: session.pipeStatusPending,
  }
}

/**
 * Put back the status a line found, for a line the caller aborted.
 * Statements inside the line may already have stamped their own status
 * before the abort landed, and an aborted invocation is the caller's
 * outcome, not the shell's.
 *
 * Only what this line overwrote, though. Two `execute()` calls can
 * share a session, and a snapshot taken before a concurrent line
 * finished is older than that line's result: putting it back would
 * resurrect a value the shell had already moved past. So the restore
 * happens only while the last stamp is still this line's. When nobody
 * has stamped since the snapshot the status already equals it and
 * declining is the same thing; when someone else did, declining is the
 * point.
 */
export function restoreStatus(
  session: SessionState,
  snapshot: StatusSnapshot,
  writer: StatusWriter | null,
): void {
  if (session.statusWriter !== writer) return
  session.lastExitCode = snapshot.lastExitCode
  session.pipeStatus = snapshot.pipeStatus
  session.pipeStatusPending = snapshot.pipeStatusPending
}

/**
 * Park the status just recorded again, for the boundary that closes the
 * enclosing statement to claim rather than stamp over. A conditional
 * list that short-circuits has closed its left pipeline and runs
 * nothing else, and bash reports the list as that pipeline:
 * `true | false && true` keeps `0 1`. The list is not a pipeline of its
 * own, so without this its boundary would stamp the aggregate `1`.
 */
export function carryStatus(session: SessionState): void {
  session.pipeStatusPending = session.pipeStatus
}

/**
 * Finalize a completed statement and seed $? for the next one.
 *
 * Every statement boundary must do the same dance: apply a VALUE
 * barrier so lazily finalized exit codes (grep's) are
 * concrete, then record the status the next statement's $? expands
 * to. Statement-list loops (program, subshell, brace group, if/loop/
 * case bodies, function bodies, && / || / ; lists) call this instead
 * of hand-rolling the triple, so a new construct cannot forget it. The
 * node, when the caller has it, decides whether the statement stamps
 * `PIPESTATUS` itself; without one it stamps.
 */
export async function finishStatement(
  stdout: ByteSource | null,
  io: IOResult,
  session: SessionState,
  node: TSNodeLike | null = null,
  execNode: ExecutionNode | null = null,
): Promise<ByteSource | null> {
  // The barrier is the first pull of a lazy stream, so a read that fails
  // there (`cat` on a closed stdin, a size guard) is the statement's
  // failure, in the command's own words, rather than an exception that
  // escapes the body and kills the line; the program loop drains the
  // same way.
  let result: ByteSource | null
  try {
    result = await applyBarrier(stdout, io, BarrierPolicy.VALUE)
  } catch (err) {
    await failedRead(io, err, execNode)
    result = null
  }
  recordStatus(session, io.exitCode, node !== null && pipelineTransparent(node))
  return result
}

/**
 * A read the statement's output stream failed, as its own failure: `cat: -:
 * Bad file descriptor` on its stderr and status. Anything but a filesystem
 * error is rethrown. Mirrors Python's failed_read.
 */
export async function failedRead(
  io: IOResult,
  err: unknown,
  execNode: ExecutionNode | null,
): Promise<void> {
  if (!(err instanceof Error) || (err as { code?: string }).code === undefined) throw err
  const cmdName = execNode?.command?.split(' ')[0] ?? ''
  io.stderr = concat([
    await materialize(io.stderr),
    formatFsError(cmdName, err, execNode?.paths ?? []),
  ])
  io.exitCode = readFailExitCode(cmdName, err)
}

/**
 * Exit status of an assignment-only statement.
 *
 * Bash: an assignment statement exits 0 unless expanding it ran
 * command substitutions, in which case the status of the last
 * substitution performed becomes the statement's own.
 */
/**
 * What the shell's fd 0 is bound to: the descriptor `exec <` opened, and
 * whether an `exec` left it unreadable (`exec <&-`). A construct takes
 * this as it starts, so `statementStdin` can tell an `exec` made inside
 * it from one made before it.
 */
export function fd0Binding(session: SessionState): readonly [SharedInput | null, boolean] {
  return [session.execStdin, session.execStdinUnreadable]
}

/**
 * The stdin one statement of a construct reads.
 *
 * bash's fd 0 is one descriptor, so an `exec <` replaces whatever a
 * construct was handed: `printf z | { exec < f; read a; }` reads `f`.
 * Every statement-list loop asks this before each statement. The
 * construct's own stdin stands while fd 0 is still what it was when the
 * construct started (`bound`); a construct handed none reads fd 0, the
 * descriptor `exec <` opened or EBADF after `exec <&-`.
 */
export function statementStdin(
  session: SessionState,
  stdin: ByteSource | null,
  bound: readonly [SharedInput | null, boolean],
): ByteSource | null {
  if (
    stdin !== null &&
    session.execStdin === bound[0] &&
    session.execStdinUnreadable === bound[1]
  ) {
    return stdin
  }
  if (session.execStdinUnreadable) return unreadableStdin()
  return session.execStdin ?? stdin
}

export function assignmentStatus(frame: ExecutionFrame, seqBefore: number): number {
  if (frame.cmdsubSeq !== seqBefore) return frame.cmdsubStatus
  return 0
}

/**
 * One piece of what a statement wrote, in order: its channel, its bytes, and
 * whether it went to the terminal through a copy, which an `exec` diversion of
 * the shell's own output leaves where it is. Mirrors Python's Written.
 */
export type Written = readonly [Channel, Uint8Array, boolean]

/**
 * Output written as it is, stdout then stderr, none of it through a copy of
 * the terminal. Mirrors Python's as_written.
 */
export function asWritten(stdout: Uint8Array | null, stderr: Uint8Array | null): Written[] {
  const written: Written[] = []
  if (stdout !== null && stdout.byteLength > 0) written.push([Channel.STDOUT, stdout, false])
  if (stderr !== null && stderr.byteLength > 0) written.push([Channel.STDERR, stderr, false])
  return written
}

/**
 * Run a statement into `recorder`: what it writes to an enclosing level's
 * stream, and what a job this shell started writes while it runs, land among
 * what it writes. Mirrors Python's recording.
 */
export async function recording<T>(
  session: SessionState,
  recorder: Recorder,
  run: () => Promise<T>,
): Promise<T> {
  const jobs = session.jobOutput ?? session.tty.jobs
  const held = jobs.recorder
  jobs.recorder = recorder
  try {
    return await ENCLOSING.run(recorder, run)
  } finally {
    jobs.recorder = held
  }
}

/**
 * What a statement wrote that stays with the shell running it, taken off
 * `recorder`. Bytes written to the shell's terminal through a copy (`exec
 * 3>&1`, whose owner is `own`) stay, flagged; bytes written to an enclosing
 * level's stream go on there. What the statement returned rather than wrote
 * comes last, its stderr taken off `io`. Mirrors Python's statement_output.
 */
export async function statementOutput(
  recorder: Recorder,
  stdout: ByteSource | null,
  io: IOResult,
  own: StreamOwner | null,
  sink: JobConsole | null,
): Promise<Written[]> {
  const written: Written[] = []
  for (const [key, data] of recorder.chunks.splice(0)) {
    if (!(key instanceof Inherited)) written.push([key, data, false])
    else if (key.owner === own || !(await deliver(sink, key, data)))
      written.push([key.channel, data, true])
  }
  const out = await materialize(stdout)
  if (out.byteLength > 0) written.push([Channel.STDOUT, out, false])
  const err = await materialize(io.stderr)
  io.stderr = null
  if (err.byteLength > 0) written.push([Channel.STDERR, err, false])
  return written
}

/**
 * Put a statement's output where its shell's goes: the sink, in order, or the
 * stdout and stderr the shell returns. The result keeps its status. Mirrors
 * Python's land.
 */
export async function land(
  written: readonly Written[],
  sink: JobConsole | null,
  allStdout: (ByteSource | null)[],
  mergedIo: IOResult,
): Promise<IOResult> {
  if (sink !== null) {
    for (const [channel, data] of written) await sink.emit(channel, data)
    return mergedIo
  }
  const stdout = concat(written.filter(([c]) => c === Channel.STDOUT).map(([, d]) => d))
  if (stdout.byteLength > 0) allStdout.push(stdout)
  const stderr = concat(written.filter(([c]) => c === Channel.STDERR).map(([, d]) => d))
  return stderr.byteLength > 0
    ? mergedIo.merge(new IOResult({ stderr, exitCode: mergedIo.exitCode }))
    : mergedIo
}
