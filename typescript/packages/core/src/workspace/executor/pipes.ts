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

import { childContext, type EvaluationContext } from '../evaluation.ts'
import { runWithEvaluation } from '../../context/session_context.ts'

import type { ProcessHandle } from '../../process/handle.ts'
import type { ProcessSupervisor } from '../../process/supervisor.ts'
import { PathSpec } from '../../types.ts'
import { runWithTimeout } from '../../commands/builtin/utils/limit.ts'
import { asyncChain, closeQuietly, discardIo, discardStreams } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult, materialize } from '../../io/types.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { divertStatement } from './builtins/exec/index.ts'
import {
  asWritten,
  carryStatus,
  errexitActs,
  fd0Binding,
  finishStatement,
  ignoringErrexit,
  land,
  recordStatus,
  recording,
  statementOutput,
  statementStdin,
} from './statement.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal, PipeClosed, ReturnSignal } from '../../shell/errors.ts'
import { carried, ended, isUnwinding } from './control.ts'
import { FORK_FAILED, FORK_FAILED_STATUS } from '../../shell/constants.ts'
import { NodeType as NT } from '../../shell/types.ts'
import { simpleCommand } from '../../shell/node_kind.ts'
import { type JobTable, JobWaits } from '../../shell/job_table/index.ts'

import type { TSNodeLike } from '../../shell/types.ts'
import { ExecutionNode } from '../types.ts'
import type { SessionState } from '../session/session.ts'
import { handleBackground, pump } from './jobs.ts'
import type { ExecuteNodeFn } from './command/types.ts'
import { endShell, errTrapArmed, inheritTraps, runErrTrap, runExitTrap } from './traps.ts'
import type { ExecuteStringFn } from './builtins/types.ts'
import type { ExecuteFn } from '../expand/node.ts'
import type { Decisions } from '../../policy/decisions.ts'
import type { HandOff } from '../../policy/types.ts'

import { PipeConsole } from '../../shell/console/pipe.ts'
import { type JobConsole, JobOutput } from '../../shell/console/index.ts'
import { Recorder } from '../../shell/descriptors.ts'
import { Channel } from '../../shell/console/types.ts'

import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { abortable, makeAbortError, mergeSignals } from '../../utils/abort.ts'
import { concat } from '../../utils/bytes.ts'
import { encodeText } from '../../shell/bytes.ts'
import { CAPACITY } from '../../io/pipe.ts'

type Result = [ByteSource | null, IOResult, ExecutionNode]

export async function handlePipe(
  executeNode: ExecuteNodeFn,
  commands: readonly TSNodeLike[],
  stderrFlags: readonly boolean[],
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  signal?: AbortSignal,
  processes?: ProcessSupervisor,
  // Each stage is a child shell, which runs its own EXIT action through
  // this when it ends.
  executeFn: ExecuteFn | null = null,
  bufferBytes = CAPACITY,
  // Where the statement's output goes as it arrives; the last stage
  // streams into it instead of being collected first.
  sink?: JobConsole,
): Promise<Result> {
  const session = context.session
  // Reassociated pipelines can enter here without executeNode resetting
  // the parent. An exemption belongs to the preceding statement only;
  // the caller applies this pipeline's own negation after it finishes.
  session.errexitImmune = false
  const pipes = commands.map((_, i) => new PipeConsole(stderrFlags[i] === true, bufferBytes))
  const ios: IOResult[] = commands.map(() => new IOResult())
  // A stage the top shell forks for a simple command is that command's
  // shell; one a child shell forks is a child of a child.
  const forked = callStack?.subshell === true
  const childNodes: ExecutionNode[] = commands.map(() => new ExecutionNode())
  const abort = new AbortController()
  const parentSignal = mergeSignals(signal, context.frame.abortSignal)
  const onAbort = (): void => {
    abort.abort(parentSignal?.reason)
    for (const pipe of pipes) pipe.closeReader()
    // The shell's own fd 0 outlives the line, as bash's does.
    if (stdin !== session.execStdin) void discardStreams(stdin)
  }
  parentSignal?.addEventListener('abort', onAbort, { once: true })
  if (parentSignal?.aborted === true) onAbort()

  let failed = false
  const tasks: Promise<void>[] = []
  const launch = (cmd: TSNodeLike, i: number): Promise<void> => {
    // Each segment is a child shell: bash forks one per stage.
    const childEvaluation = childContext(context)
    const child = childEvaluation.session
    inheritTraps(child)
    child.terminalOutput = session.terminalOutput && i === commands.length - 1
    childEvaluation.frame.abortSignal =
      mergeSignals(context.frame.abortSignal, abort.signal) ?? abort.signal
    const output = pipes[i]
    if (output === undefined) throw new Error('Missing pipeline segment')
    const upstream = pipes[i - 1]
    const input = i === 0 ? stdin : (upstream?.stream() ?? null)
    const run = async (): Promise<void> => {
      let io = new IOResult()
      let childExec = new ExecutionNode({ command: cmd.text })
      const stageStack = (callStack ?? new CallStack()).fork(true, simpleCommand(cmd) ? null : true)
      // A job a stage before the last starts writes into the pipe, and
      // the reader sees end of input only once the job has closed it.
      const waits =
        i < commands.length - 1
          ? new JobWaits(
              new JobOutput(output),
              new Set(
                stderrFlags[i] === true ? [Channel.STDOUT, Channel.STDERR] : [Channel.STDOUT],
              ),
            )
          : null
      if (waits !== null) {
        child.jobOutput = waits.output
        child.jobWaits = waits
      }
      const rest = session.jobOutput ?? session.tty.jobs
      try {
        const [stdout, result, execution] = await endShell(
          executeFn,
          child,
          input,
          stageStack,
          executeNode(cmd, childEvaluation, input, stageStack, {
            sink: output,
            signal: abort.signal,
          }),
        )
        io = result
        childExec = execution
        await pump(output, Channel.STDOUT, stdout)
        await pump(output, Channel.STDERR, io.stderr)
        await waits?.join(rest)
      } catch (error) {
        if (error instanceof PipeClosed) {
          io.exitCode = 141
        } else if (isUnwinding(error)) {
          // A stage is a subshell: whatever unwinds ends it there, a simple
          // command the top shell forked as that shell would.
          const unwound = ended(error, simpleCommand(cmd) && !forked)
          io.exitCode = unwound.exitCode
          await pump(output, Channel.STDOUT, unwound.stdout)
          await pump(output, Channel.STDERR, unwound.stderr)
          await waits?.join(rest)
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
    const execute = () =>
      asyncContextIsolatesTasks ? runWithEvaluation(childEvaluation, run) : run()
    if (processes === undefined) return execute()
    let process: ProcessHandle
    try {
      process = processes.start({
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
        limit: session.processes.max,
      })
    } catch (error) {
      if ((error as { code?: unknown }).code === 'EAGAIN')
        throw new ExitSignal(FORK_FAILED_STATUS, encodeText(FORK_FAILED))
      throw error
    }
    child.processId = process.info.pid
    return process.task.then(() => undefined)
  }
  let lastStdout: ByteSource | null = null
  try {
    // A stage the session cannot fork ends the pipeline: the stages
    // already started are aborted below, as bash kills the pipeline.
    commands.forEach((cmd, i) => {
      tasks.push(launch(cmd, i))
    })
    const completed = Promise.all(tasks)
    // Attach the rejection handler before reading the last segment: an
    // upstream failure must settle the pipeline even if nobody reads it.
    const last = pipes[pipes.length - 1]?.stream() ?? null
    const reading =
      sink === undefined ? materialize(last) : pump(sink, Channel.STDOUT, last).then(() => null)
    const result = await runWithTimeout(
      abortable(Promise.all([reading, completed]), parentSignal),
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
      // The shell's own fd 0 outlives the line, as bash's does: the next
      // line reads on from it.
      await discardStreams(lastStdout, stdin === session.execStdin ? null : stdin)
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

  for (let i = 0; i < ios.length; i++) {
    const io = ios[i]
    const child = childNodes[i]
    if (io === undefined || child === undefined) continue
    child.exitCode = io.exitCode
    const stderrBytes = await materialize(io.stderr)
    if (stderrBytes.byteLength > 0) mergedStderrParts.push(stderrBytes)
  }

  if (mergedStderrParts.length > 0) {
    lastIo.stderr = concat(mergedStderrParts)
  }

  const execNode = new ExecutionNode({
    op: '|',
    exitCode: lastIo.exitCode,
    children: childNodes,
  })
  return [lastStdout, lastIo, execNode]
}

/**
 * Handle `&&` and `||`. The left command runs where `set -e` is ignored.
 * The right one is the list's own: the ERR action is armed as it starts
 * and answers its failure, which the statement holding the list then does
 * not. Mirrors Python's handle_connection.
 */
export async function handleConnection(
  executeNode: ExecuteNodeFn,
  left: TSNodeLike,
  op: string | null,
  right: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  executeFn: ExecuteStringFn | null = null,
): Promise<Result> {
  const session = context.session
  const bound = fd0Binding(session)
  const [leftStdout, leftIo, leftExec] = await ignoringErrexit(session, () =>
    executeNode(left, context, stdin, callStack),
  )
  const children = [leftExec]

  const leftBytes = await finishStatement(leftStdout, leftIo, session, left)
  if ((op === NT.AND && leftIo.exitCode !== 0) || (op === NT.OR && leftIo.exitCode === 0)) {
    if (op === NT.AND) session.errexitImmune = true
    carryStatus(session)
    return [leftBytes, leftIo, new ExecutionNode({ op, exitCode: leftIo.exitCode, children })]
  }
  let rightStdout: ByteSource | null
  let rightIo: IOResult
  let rightExec: ExecutionNode
  const armed = errTrapArmed(session)
  try {
    ;[rightStdout, rightIo, rightExec] = await executeNode(
      right,
      context,
      statementStdin(session, stdin, bound),
      callStack,
    )
  } catch (err) {
    if (isUnwinding(err)) throw await carried(err, leftBytes, leftIo)
    throw err
  }
  children.push(rightExec)
  // The right command closes here, so its ERR action reads its status and
  // `${PIPESTATUS[@]}`; the list's boundary claims them again once the
  // action is done.
  const rightBytes = await finishStatement(rightStdout, rightIo, session, right)
  let merged = await leftIo.merge(rightIo)
  const outputs: (ByteSource | null)[] = [leftBytes, rightBytes]
  try {
    merged = await land(
      await runErrTrap(
        executeFn,
        right,
        rightIo.exitCode,
        session,
        armed,
        stdin,
        callStack,
        rightExec,
      ),
      null,
      outputs,
      merged,
    )
  } catch (err) {
    if (isUnwinding(err)) throw await carried(err, asyncChain(outputs), merged)
    throw err
  }
  carryStatus(session)
  const combined = asyncChain(outputs)
  return [
    combined,
    merged,
    new ExecutionNode({ op: op ?? ';', exitCode: merged.exitCode, children }),
  ]
}

/**
 * End a subshell on an `exit` (or `${var:?}`), or the `return` of a
 * function it runs in, that left a statement or the ERR action answering
 * one: a subshell is its own shell, and the signal's status is the
 * subshell's. Mirrors Python's _subshell_ended.
 */
async function subshellEnded(
  err: ExitSignal | ReturnSignal,
  recorder: Recorder,
  session: SessionState,
  sink: JobConsole | null,
  allStdout: (ByteSource | null)[],
  mergedIo: IOResult,
): Promise<[IOResult, ExecutionNode]> {
  mergedIo = await land(
    await statementOutput(recorder, err.stdout, new IOResult(), session.terminal, sink),
    sink,
    allStdout,
    mergedIo,
  )
  const status = ended(err).exitCode
  mergedIo = await mergedIo.merge(new IOResult({ exitCode: status, stderr: err.stderr }))
  mergedIo.exitCode = status
  recordStatus(session, status)
  return [mergedIo, new ExecutionNode({ command: '()', exitCode: status, stderr: err.stderr })]
}

/**
 * Run a subshell's body in the child shell its caller made.
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
  context: EvaluationContext,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  jobTable: JobTable | null = null,
  agentId: string | null = null,
  // The dispatcher, so a subshell honors an `exec` redirect the way the
  // program loop does. A subshell is a child shell, so the redirect it
  // installs belongs to the child and is discarded when the body
  // ends.
  dispatch?: DispatchFn,
  // The line's hand-off and its ledger, for a background job to borrow.
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
  // Where each statement's output goes as it finishes; the body is a shell
  // of its own, which routes what it wrote to its terminal through a copy,
  // so a program nested in it (`$( )`, `eval`) leaves that to it.
  sink: JobConsole | null = null,
  // Runs the subshell's own EXIT action as it ends.
  executeFn: ExecuteFn | null = null,
): Promise<Result> {
  const session = context.session
  inheritTraps(session)
  session.jobOutput = new JobOutput(session.jobOutput ?? session.tty.jobs)
  session.lineOpen = true
  // A child shell: `shift` or `set --` in it leaves the caller's
  // parameters alone, and it runs in none of the caller's loops.
  callStack = (callStack ?? new CallStack()).fork(false, true)
  // The subshell's actions run as its own lines: their `wait` and `jobs`
  // see the subshell's jobs, not the caller's.
  const runAction: ExecuteStringFn | null =
    executeFn === null
      ? null
      : (action, opts) =>
          executeFn(action, { ...opts, session, ...(jobTable === null ? {} : { jobTable }) })
  const allStdout: (ByteSource | null)[] = []
  let mergedIo = new IOResult()
  let lastExec = new ExecutionNode({ command: '()', exitCode: 0 })
  const bound = fd0Binding(session)
  let i = 0
  while (i < body.length) {
    const child = body[i]
    if (child?.isNamed !== true || child.type === NT.COMMENT) {
      i += 1
      continue
    }
    // `set -n` needs no arm here: `executeNode` refuses every node
    // while the option is on, so this loop simply runs a tail of
    // no-ops. The child owns the option, so it cannot leak to the parent.
    const isBg = body[i + 1]?.type === NT.BACKGROUND
    const armed = errTrapArmed(session)
    if (isBg && jobTable !== null) {
      let launched: Result
      try {
        launched = await handleBackground(
          executeNode,
          child,
          null,
          context,
          jobTable,
          agentId ?? '',
          stdin,
          callStack,
          handed,
          decisions,
        )
      } catch (err) {
        if (!(err instanceof ExitSignal)) throw err
        // A job the subshell cannot fork ends the subshell only, its
        // status the subshell's.
        mergedIo = await mergedIo.merge(
          new IOResult({ exitCode: err.containedCode, stderr: err.stderr }),
        )
        mergedIo.exitCode = err.containedCode
        recordStatus(session, err.containedCode)
        lastExec = new ExecutionNode({
          command: '()',
          exitCode: err.containedCode,
          stderr: err.stderr,
        })
        break
      }
      const [bgStdout, bgIo, bgExec] = launched
      if (bgStdout !== null) allStdout.push(bgStdout)
      mergedIo = await mergedIo.merge(bgIo)
      // Seed $? for later body commands (mirrors program loop).
      recordStatus(session, bgIo.exitCode)
      lastExec = bgExec
      i += 2
      continue
    }
    i += 1
    const recorder = new Recorder()
    let io: IOResult
    try {
      const childStdin = statementStdin(session, stdin, bound)
      let stdout: ByteSource | null
      ;[stdout, io, lastExec] = await recording(session, recorder, () =>
        executeNode(child, context, childStdin, callStack, { sink: recorder }),
      )
      stdout = await finishStatement(stdout, io, session, child, lastExec)
      const written = await divertStatement(
        dispatch,
        session,
        await statementOutput(recorder, stdout, io, session.terminal, sink),
        io,
        child,
        lastExec.command ?? '',
      )
      mergedIo = await land(written, sink, allStdout, mergedIo)
      mergedIo = await mergedIo.merge(io)
      mergedIo = await land(
        await runErrTrap(runAction, child, io.exitCode, session, armed, stdin, callStack, lastExec),
        sink,
        allStdout,
        mergedIo,
      )
    } catch (err) {
      if (!(err instanceof ExitSignal || err instanceof ReturnSignal)) throw err
      ;[mergedIo, lastExec] = await subshellEnded(err, recorder, session, sink, allStdout, mergedIo)
      break
    }
    if (errexitActs(child, io.exitCode, session)) break
  }
  const cleanup = await runExitTrap(runAction, session, mergedIo.exitCode, stdin, callStack)
  if (cleanup !== null) {
    mergedIo = await land(
      asWritten(await cleanup.materializeStdout(), await cleanup.materializeStderr()),
      sink,
      allStdout,
      mergedIo,
    )
    mergedIo.exitCode = cleanup.exitCode
    lastExec = new ExecutionNode({ command: '()', exitCode: cleanup.exitCode })
  }
  const parts = allStdout.filter((part): part is ByteSource => part !== null)
  if (parts.length === 1 && parts[0] !== undefined) {
    return [parts[0], mergedIo, lastExec]
  }
  const combined = parts.length > 0 ? asyncChain(parts) : null
  return [combined, mergedIo, lastExec]
}
