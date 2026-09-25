import type { ProcessSupervisor } from '../../process/supervisor.ts'
import { PathSpec } from '../../types.ts'
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
import { asyncChain, closeQuietly, discardIo, discardStreams } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { divertStatement, stdoutToStderr } from './builtins/exec/index.ts'
import { carryStatus, finishStatement, recordStatus } from './statement.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal, PipeClosed } from '../../shell/errors.ts'
import { ERREXIT_EXEMPT_TYPES } from '../../shell/constants.ts'
import { NodeType as NT } from '../../shell/types.ts'
import type { JobTable } from '../../shell/job_table/index.ts'
import { unreadableStdin } from '../../shell/descriptors.ts'
import type { SessionState } from '../session/session.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { ExecutionNode } from '../types.ts'
import { type ExecuteNodeFn, handleBackground, pump } from './jobs.ts'
import type { Decisions } from '../../policy/decisions.ts'
import type { HandOff } from '../../policy/types.ts'

import { PipeConsole } from '../../shell/console/pipe.ts'
import { Channel } from '../../shell/console/types.ts'
import { runWithSession } from '../../context/session_context.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { abortable, makeAbortError, mergeSignals } from '../abort.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function handlePipe(
  executeNode: ExecuteNodeFn,
  commands: readonly TSNodeLike[],
  stderrFlags: readonly boolean[],
  session: SessionState,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  signal?: AbortSignal,
  processes?: ProcessSupervisor,
): Promise<Result> {
  const pipes = commands.map((_, i) => new PipeConsole(stderrFlags[i] === true))
  const ios: IOResult[] = commands.map(() => new IOResult())
  const childNodes: ExecutionNode[] = commands.map(() => new ExecutionNode())
  const abort = new AbortController()
  const parentSignal = mergeSignals(signal, session.abortSignal)
  const onAbort = (): void => {
    abort.abort(parentSignal?.reason)
    for (const pipe of pipes) pipe.closeReader()
    void discardStreams(stdin)
  }
  parentSignal?.addEventListener('abort', onAbort, { once: true })
  if (parentSignal?.aborted === true) onAbort()

  let failed = false
  const tasks = commands.map((cmd, i) => {
    const child = session.fork()
    child.abortSignal = mergeSignals(session.abortSignal, abort.signal) ?? abort.signal
    const output = pipes[i]
    if (output === undefined) throw new Error('Missing pipeline segment')
    const upstream = pipes[i - 1]
    const input = i === 0 ? stdin : (upstream?.stream() ?? null)
    const run = async (): Promise<void> => {
      let io = new IOResult()
      let childExec = new ExecutionNode({ command: cmd.text })
      try {
        const [stdout, result, execution] = await executeNode(
          cmd,
          child,
          input,
          callStack?.fork() ?? null,
          { sink: output, signal: abort.signal },
        )
        io = result
        childExec = execution
        await pump(output, Channel.STDOUT, stdout)
        await pump(output, Channel.STDERR, io.stderr)
      } catch (error) {
        if (error instanceof PipeClosed) {
          io.exitCode = 141
        } else if (error instanceof ExitSignal) {
          io.exitCode = error.containedCode
          await pump(output, Channel.STDOUT, error.stdout)
          await pump(output, Channel.STDERR, error.stderr)
        } else {
          output.end(error)
          throw error
        }
      } finally {
        upstream?.release()
        if (input !== null && !(input instanceof Uint8Array)) await closeQuietly(input)
        output.end()
        io.stderr = await output.snapshot(Channel.STDERR)
        ios[i] = io
        childNodes[i] = childExec
        if (failed) await discardIo(io)
      }
    }
    const execute = () => (asyncContextIsolatesTasks ? runWithSession(child, run) : run())
    if (processes === undefined) return execute()
    const process = processes.start({
      sessionId: session.sessionId,
      command: cmd.text,
      cwd: PathSpec.fromStrPath(child.cwd),
      parentPid: session.processId,
      cancel: () => {
        abort.abort()
      },
      run: async () => {
        await execute()
        return ios[i]?.exitCode ?? 0
      },
    })
    child.processId = process.info.pid
    return process.task.then(() => undefined)
  })
  const completed = Promise.all(tasks)
  // Attach the rejection handler before reading the last segment: an
  // upstream failure must settle the pipeline even if nobody reads it.
  let lastStdout: ByteSource | null = null
  try {
    const result = await runWithTimeout(
      abortable(
        Promise.all([materialize(pipes[pipes.length - 1]?.stream() ?? null), completed]),
        parentSignal,
      ),
      session.pipelineTimeoutSeconds,
      'pipeline',
    )
    if (parentSignal?.aborted === true) throw makeAbortError(parentSignal)
    lastStdout = result[0]
  } catch (error) {
    failed = true
    throw error
  } finally {
    parentSignal?.removeEventListener('abort', onAbort)
    // Completed segments may leave cache streams for background drains.
    // Python only cancels unfinished tasks here; aborting a successful
    // pipeline would also cancel those streams after ownership passed on.
    if (failed) abort.abort()
    for (const pipe of pipes) pipe.closeReader()
    const settled = Promise.allSettled(tasks)
    if (!failed) await settled
    if (failed) {
      for (const io of ios) await discardIo(io)
      await discardStreams(lastStdout, stdin)
    }
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
  session: SessionState,
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
  session: SessionState,
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
