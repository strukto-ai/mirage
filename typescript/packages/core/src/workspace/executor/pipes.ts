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

import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { asyncChain, closeQuietly, mergeStdoutStderr } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { divertStatement, stdoutToStderr } from './builtins/exec/index.ts'
import { carryStatus, finishStatement, recordStatus } from './statement.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { unreadableStdin } from '../../shell/descriptors.ts'
import type { Session } from '../session/session.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { ExecutionNode } from '../types.ts'
import { type ExecuteNodeFn, handleBackground } from './jobs.ts'
import type { Decisions } from '../../policy/decisions.ts'
import type { HandOff } from '../../policy/types.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function handlePipe(
  executeNode: ExecuteNodeFn,
  commands: readonly TSNodeLike[],
  stderrFlags: readonly boolean[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  let currentStdin: ByteSource | null = stdin
  let lastStdout: ByteSource | null = null
  const childNodes: ExecutionNode[] = []
  const ios: IOResult[] = []
  const intermediate: ByteSource[] = []
  // Every segment is a child shell forked before the pipeline ran, so
  // each expands `$?` to the status the pipeline started with, not to
  // what a sibling's inner statements left behind (`false; { true; } |
  // echo $?` prints 1). The snapshot does not carry it: after a child
  // shell `$?` is the child's status, which is the one thing it reports
  // back. Seeded through the status door, which leaves `${PIPESTATUS[@]}`
  // alone.
  const before = session.lastExitCode

  try {
    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]
      if (cmd === undefined) continue
      let stdout: ByteSource | null
      let io: IOResult
      let childExec: ExecutionNode
      const saved = session.snapshot()
      recordStatus(session, before, true)
      try {
        ;[stdout, io, childExec] = await executeNode(cmd, session, currentStdin, callStack)
      } catch (err) {
        if (!(err instanceof ExitSignal)) throw err
        // Each pipeline segment is its own shell in bash: exit
        // (or ${var:?}) ends the segment, not the pipeline.
        stdout = err.stdout
        io = new IOResult({ exitCode: err.containedCode, stderr: err.stderr })
        childExec = new ExecutionNode({
          command: cmd.text,
          exitCode: err.containedCode,
          stderr: err.stderr,
        })
      } finally {
        session.restore(saved)
      }
      ios.push(io)
      childNodes.push(childExec)

      if (i < commands.length - 1) {
        const pipeStderr = i < stderrFlags.length && stderrFlags[i] === true
        const piped = pipeStderr ? mergeStdoutStderr(stdout, io) : stdout
        currentStdin = piped ?? new Uint8Array()
        if (!(currentStdin instanceof Uint8Array)) {
          intermediate.push(currentStdin)
        }
      }
      lastStdout = stdout
    }

    if (lastStdout !== null && !(lastStdout instanceof Uint8Array)) {
      lastStdout = await runWithTimeout(
        materialize(lastStdout),
        session.pipelineTimeoutSeconds,
        'pipeline',
      )
    }
  } finally {
    for (const s of intermediate) await closeQuietly(s)
  }

  const lastIo = ios[ios.length - 1] ?? new IOResult()
  // Parked for the boundary that closes this statement to claim as
  // `${PIPESTATUS[@]}`: the raw per-segment statuses, before pipefail
  // rewrites the pipeline's own.
  session.pipeStatusPending = ios.map((io) => io.exitCode)
  if (session.shellOptions.pipefail === true) {
    let rightmostFailure = 0
    for (let k = ios.length - 1; k >= 0; k--) {
      const code = ios[k]?.exitCode ?? 0
      if (code !== 0) {
        rightmostFailure = code
        break
      }
    }
    if (rightmostFailure !== 0) lastIo.exitCode = rightmostFailure
  }
  const mergedStderrParts: Uint8Array[] = []
  const mergedReads: Record<string, ByteSource> = {}
  const mergedWrites: Record<string, ByteSource> = {}
  const mergedCache: string[] = []

  for (let i = 0; i < ios.length; i++) {
    const io = ios[i]
    const child = childNodes[i]
    if (io === undefined || child === undefined) continue
    child.exitCode = io.exitCode
    const stderrBytes = await materialize(io.stderr)
    if (stderrBytes.byteLength > 0) mergedStderrParts.push(stderrBytes)
    Object.assign(mergedReads, io.reads)
    Object.assign(mergedWrites, io.writes)
    mergedCache.push(...io.cache)
  }

  if (mergedStderrParts.length > 0) {
    lastIo.stderr = concat(mergedStderrParts)
  }
  lastIo.reads = mergedReads
  lastIo.writes = mergedWrites
  lastIo.cache = mergedCache

  const execNode = new ExecutionNode({
    op: '|',
    exitCode: lastIo.exitCode,
    children: childNodes,
  })
  return [lastStdout, lastIo, execNode]
}

async function mergeLeftIntoExit(
  sig: ExitSignal,
  leftBytes: ByteSource | null,
  leftIo: IOResult,
): Promise<ExitSignal> {
  // Fold the left side's completed output into a propagating exit.
  const leftStderr = await materialize(leftIo.stderr)
  const left = await materialize(leftBytes)
  sig.stdout = concat([left, sig.stdout ?? new Uint8Array()])
  sig.stderr = concat([leftStderr, sig.stderr])
  return sig
}

export async function handleConnection(
  executeNode: ExecuteNodeFn,
  left: TSNodeLike,
  op: string | null,
  right: TSNodeLike,
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<Result> {
  const [leftStdout, leftIo, leftExec] = await executeNode(left, session, stdin, callStack)
  const children = [leftExec]

  if (op === NT.AND) {
    const leftBytes = await finishStatement(leftStdout, leftIo, session, left)
    if (leftIo.exitCode !== 0) {
      // The failing command is left of the final `&&`, which bash
      // exempts from `set -e`. The list ran only its left side, so the
      // list boundary reports that pipeline.
      session.errexitImmune = true
      carryStatus(session)
      return [
        leftBytes,
        leftIo,
        new ExecutionNode({ op: '&&', exitCode: leftIo.exitCode, children }),
      ]
    }
    let rightStdout: ByteSource | null
    let rightIo: IOResult
    let rightExec: ExecutionNode
    try {
      ;[rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
    } catch (err) {
      if (err instanceof ExitSignal) throw await mergeLeftIntoExit(err, leftBytes, leftIo)
      throw err
    }
    children.push(rightExec)
    const rightBytes = await materialize(rightStdout)
    const merged = await leftIo.merge(rightIo)
    const combined = asyncChain(leftBytes, rightBytes)
    return [combined, merged, new ExecutionNode({ op: '&&', exitCode: merged.exitCode, children })]
  }

  if (op === NT.OR) {
    const leftBytes = await finishStatement(leftStdout, leftIo, session, left)
    if (leftIo.exitCode === 0) {
      carryStatus(session)
      return [
        leftBytes,
        leftIo,
        new ExecutionNode({ op: '||', exitCode: leftIo.exitCode, children }),
      ]
    }
    let rightStdout: ByteSource | null
    let rightIo: IOResult
    let rightExec: ExecutionNode
    try {
      ;[rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
    } catch (err) {
      if (err instanceof ExitSignal) throw await mergeLeftIntoExit(err, leftBytes, leftIo)
      throw err
    }
    children.push(rightExec)
    const rightBytes = await materialize(rightStdout)
    const merged = await leftIo.merge(rightIo)
    const combined = asyncChain(leftBytes, rightBytes)
    return [combined, merged, new ExecutionNode({ op: '||', exitCode: merged.exitCode, children })]
  }

  // ; (semicolon) or other: run both regardless
  const leftBytes = await finishStatement(leftStdout, leftIo, session, left)
  let rightStdout: ByteSource | null
  let rightIo: IOResult
  let rightExec: ExecutionNode
  try {
    ;[rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
  } catch (err) {
    if (err instanceof ExitSignal) throw await mergeLeftIntoExit(err, leftBytes, leftIo)
    throw err
  }
  children.push(rightExec)
  const rightBytes = await materialize(rightStdout)
  const merged = await leftIo.merge(rightIo)
  const combined = asyncChain(leftBytes, rightBytes)
  return [
    combined,
    merged,
    new ExecutionNode({ op: op ?? ';', exitCode: merged.exitCode, children }),
  ]
}

/**
 * Execute body in isolated env.
 *
 * `body` is ALL subshell children, including the `&` tokens that mark
 * background statements (named-only lists would run `a & b`
 * synchronously and never set `$!`). Background jobs live in the
 * subshell's private `jobTable` (bash forks: the parent's table never
 * sees them), and `executeNode` is bound to that same table so
 * `wait`/`kill`/`jobs` inside the body resolve against it.
 */
export async function handleSubshell(
  executeNode: ExecuteNodeFn,
  body: readonly TSNodeLike[],
  session: Session,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  // The op door, so a subshell honors an `exec` redirect the way the
  // program loop does. A subshell is a child shell, so the redirect it
  // installs is restored with the rest of the snapshot when the body
  // ends.
  dispatch?: DispatchFn,
  // The line's hand-off and its ledger, for a background job to borrow.
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<Result> {
  const saved = session.snapshot()
  try {
    const allStdout: ByteSource[] = []
    let mergedIo = new IOResult()
    let lastExec = new ExecutionNode({ command: '()', exitCode: 0 })
    let i = 0
    while (i < body.length) {
      const child = body[i]
      if (child?.isNamed !== true || child.type === NT.COMMENT) {
        i += 1
        continue
      }
      // `set -n` needs no arm here: `executeNode` refuses every node
      // while the option is on, so this loop simply runs a tail of
      // no-ops. The restore at the end of the subshell is what keeps the
      // option from leaking to the parent.
      const isBg = body[i + 1]?.type === NT.BACKGROUND
      if (isBg && jobTable !== null) {
        const [bgStdout, bgIo, bgExec] = await handleBackground(
          executeNode,
          child,
          null,
          session,
          jobTable,
          agentId ?? '',
          stdin,
          callStack,
          handed,
          decisions,
        )
        if (bgStdout !== null) allStdout.push(bgStdout)
        mergedIo = await mergedIo.merge(bgIo)
        // Seed $? for later body commands (mirrors program loop).
        recordStatus(session, bgIo.exitCode)
        lastExec = bgExec
        i += 2
        continue
      }
      i += 1
      let stdout: ByteSource | null
      let io: IOResult
      let childExec: ExecutionNode
      try {
        const childStdin =
          stdin ?? (session.execStdinUnreadable ? unreadableStdin() : session.execStdin)
        ;[stdout, io, childExec] = await executeNode(child, session, childStdin, callStack)
      } catch (err) {
        if (!(err instanceof ExitSignal)) throw err
        // A subshell is its own shell: exit (or ${var:?}) ends the
        // subshell only, becoming its exit status.
        if (err.stdout !== null && err.stdout.byteLength > 0) allStdout.push(err.stdout)
        const sigIo = new IOResult({ exitCode: err.containedCode, stderr: err.stderr })
        mergedIo = await mergedIo.merge(sigIo)
        mergedIo.exitCode = err.containedCode
        recordStatus(session, err.containedCode)
        lastExec = new ExecutionNode({
          command: '()',
          exitCode: err.containedCode,
          stderr: err.stderr,
        })
        break
      }
      stdout = await finishStatement(stdout, io, session, child, childExec)
      if (dispatch !== undefined && (session.execStdout !== null || session.execStderr !== null)) {
        const bytes = stdout === null ? null : await materialize(stdout)
        const beforeDivert = io.exitCode
        stdout = await divertStatement(
          dispatch,
          session,
          bytes,
          io,
          childExec.command ?? '',
          stdoutToStderr(child),
        )
        if (io.exitCode !== beforeDivert) recordStatus(session, io.exitCode)
      }
      if (stdout !== null) allStdout.push(stdout)
      mergedIo = await mergedIo.merge(io)
      lastExec = childExec
      if (
        io.exitCode !== 0 &&
        session.shellOptions.errexit === true &&
        !ERREXIT_EXEMPT_TYPES.has(child.type) &&
        !session.errexitImmune
      ) {
        mergedIo.exitCode = io.exitCode
        break
      }
    }
    if (allStdout.length === 1 && allStdout[0] !== undefined) {
      return [allStdout[0], mergedIo, lastExec]
    }
    const combined = allStdout.length > 0 ? asyncChain(...allStdout) : null
    return [combined, mergedIo, lastExec]
  } finally {
    session.restore(saved)
  }
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
