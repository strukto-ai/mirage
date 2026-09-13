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

import { readFailExitCode } from '../../commands/spec/usage.ts'
import type { ByteSource, IOResult } from '../../io/types.ts'
import { materialize } from '../../io/types.ts'
import { formatFsError } from '../../utils/errors.ts'
import type { ExecutionNode } from '../types.ts'
import { applyBarrier, BarrierPolicy } from '../../shell/barrier.ts'
import { pipelineTransparent } from '../../shell/node_kind.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import type { Session, StatusWriter } from '../session/session.ts'
import { abortedLine, lineStatusWriter, makeAbortError } from '../abort.ts'

/**
 * Record a finished statement's exit status: `$?` and `${PIPESTATUS[@]}`
 * together.
 *
 * The one door every status write goes through, so the two can never
 * disagree. `handlePipe` parks its per-segment statuses on the session,
 * and the boundary that closes the pipeline claims them here; a boundary
 * with nothing parked stamps its own one-element status, which is what a
 * simple command, a function call or a subshell leaves in bash. A
 * *transparent* statement (a group, a loop, a negation, a redirected
 * pipeline: see `pipelineTransparent`) claims what was parked but never
 * overwrites, because bash reports the last pipeline that ran *inside* it
 * (`{ false | true; }` keeps `1 0`).
 */
export function recordStatus(session: Session, code: number, transparent = false): void {
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
 * through `recordStatus`. The status door refuses a statement that
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
export function snapshotStatus(session: Session): StatusSnapshot {
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
  session: Session,
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
export function carryStatus(session: Session): void {
  session.pipeStatusPending = session.pipeStatus
}

/**
 * Finalize a completed statement and seed $? for the next one.
 *
 * Every statement boundary must do the same dance: apply a VALUE
 * barrier so lazily finalized exit codes (grep's exitOnEmpty) are
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
  session: Session,
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
    if (!(err instanceof Error) || (err as { code?: string }).code === undefined) throw err
    const cmdName = execNode?.command?.split(' ')[0] ?? ''
    const existing = await materialize(io.stderr)
    const added = formatFsError(cmdName, err, execNode?.paths ?? [])
    const merged = new Uint8Array(existing.byteLength + added.byteLength)
    merged.set(existing, 0)
    merged.set(added, existing.byteLength)
    io.stderr = merged
    io.exitCode = readFailExitCode(cmdName, err)
    result = null
  }
  recordStatus(session, io.exitCode, node !== null && pipelineTransparent(node))
  return result
}

/**
 * Exit status of an assignment-only statement.
 *
 * Bash: an assignment statement exits 0 unless expanding it ran
 * command substitutions, in which case the status of the last
 * substitution performed becomes the statement's own.
 */
export function assignmentStatus(session: Session, seqBefore: number): number {
  if (session.cmdsubSeq !== seqBefore) return session.cmdsubStatus
  return 0
}
