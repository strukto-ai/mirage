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

import { RUN_START_WAIT_SECONDS } from '../../machine/constants.ts'
import { shellVoice } from '../../shell/voice.ts'
import type { RedirectResult } from '../../context/session_context.ts'
import { type Caller, currentCaller, runWithCaller } from '../../context/session_context.ts'
import { CommandTimeoutError } from '../../errors/types.ts'
import { holdInputs, type SharedInput } from '../../io/async_line_iterator.ts'
import { PipeClosed } from '../../io/errors.ts'
import { OutputStream } from '../../io/stream.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { LINE_NAME } from '../../policy/builtin/output_cap.ts'
import { type Decisions, isPending } from '../../policy/decisions.ts'
import type { HandOff } from '../../policy/types.ts'
import type { ProcessHandle } from '../../execution/process/handle.ts'
import type { ProcessTable } from '../../execution/process/table.ts'
import type { ProcessRunner } from '../../execution/process/types.ts'
import { encodeText } from '../../shell/bytes.ts'
import { concat } from '../../utils/bytes.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { Channel, JobConsole, JobOutput, type OwnedStream, Tee } from '../../shell/console/index.ts'
import { PipeConsole } from '../../shell/console/pipe.ts'
import {
  FD_BOTH,
  FD_CLOSE,
  FORK_FAILED,
  FORK_FAILED_STATUS,
  SHELL_IGNORED_SIGNALS,
  TIMEOUT_STATUS,
} from '../../shell/constants.ts'
import { signalReport, signalReported } from '../../shell/signals.ts'
import { ExitSignal, ReturnSignal } from '../../shell/errors.ts'
import { getPipelineStages, getRedirects, isBackgrounded } from '../../shell/helpers.ts'
import { ENDING_SIGNALS, STOP_WAIT_SECONDS } from '../../execution/job/constants.ts'
import type { JobHandle, JobTable } from '../../execution/job/index.ts'
import { NodeKind, nodeKind, simpleCommand } from '../../shell/node_kind.ts'
import { commandInvocations } from '../../shell/parse/names.ts'
import { retainPrograms } from '../../shell/parse/program.ts'
import { NodeType as NT, type TSNodeLike } from '../../shell/types.ts'
import { PathSpec, type Refusal } from '../../types.ts'
import { abortable, atDeadline, runWithDeadline } from '../../utils/abort.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import type { EvaluationContext } from '../evaluation.ts'
import { childContext } from '../evaluation.ts'
import type { ExecutionFrame } from '../frame.ts'
import { LineHandle } from '../../execution/line/handle.ts'
import { newLineId } from '../../execution/context.ts'
import { CAPTURABLE_BUILTINS, SHELL_NAMES } from '../lookup/constants.ts'
import { occurrenceOf } from '../node/occurrence.ts'
import type { SessionState } from '../session/session.ts'
import { ExecutionNode } from '../types.ts'
import type { ExecuteNodeFn, ExecuteNodeOpts } from './command/types.ts'
import {
  answerClosed,
  failedRead,
  forks,
  nestedShell,
  interleaved,
  recordStatus,
  reportedCommand,
  statementStdin,
} from './statement.ts'
import { inheritTraps } from './traps.ts'
import { sessionOf } from './builtins/jobspec.ts'

// Opt in by assigning a debug sink, as Python's module logger is off until
// configured.
export const logger: { debug?: (message: string) => void } = {}

/**
 * Send a command's output to a console as chunks arrive.
 *
 * Consuming the stream piece by piece rather than materializing it whole
 * is what lets a reader watch a running job. A command that computes its
 * output eagerly still lands in one chunk, because there was nothing to
 * observe before it finished. A pipe is drained before the next chunk is
 * pulled, so a reader that closed stops the source before it fetches more; a
 * source that reads nothing to make its bytes (`OutputStream.eager`) runs
 * ahead into the pipe's buffer, as bash's `seq 1 | sleep 30` writer does and
 * exits. With `io`, the stderr the command writes as its stream is read goes
 * out among the chunks (`interleaved`); the rest stays on `io`.
 */
export async function pump(
  console_: JobConsole,
  channel: Channel,
  stream: ByteSource | null,
  io: IOResult | null = null,
): Promise<void> {
  if (stream === null) return
  if (stream instanceof Uint8Array) {
    if (stream.byteLength > 0) await console_.emit(channel, stream)
    return
  }
  const eager = stream instanceof OutputStream && stream.eager
  const parts: AsyncIterable<[Channel, Uint8Array]> =
    io !== null ? interleaved(stream, io) : tagged(channel, stream)
  for await (const [partChannel, chunk] of parts) {
    if (chunk.byteLength > 0) await console_.emit(partChannel, chunk)
    if (partChannel !== channel || !(console_ instanceof PipeConsole)) continue
    if (!eager) await console_.drain()
    if (console_.closedReader) return
  }
}

async function* tagged(
  channel: Channel,
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<[Channel, Uint8Array]> {
  for await (const chunk of stream) yield [channel, chunk]
}

/**
 * Write a finished statement's returned output to a sink, its stderr among
 * its stdout as the stream wrote it, the rest after (`interleaved`); what it
 * already wrote there as it ran (a function body, a redirected group) came
 * first. A
 * read its stream fails is the statement's own failure (`failedRead`). The
 * result carries no output, so nothing lands twice. Mirrors Python's drained.
 */
export async function drained(
  sink: JobConsole,
  stdout: ByteSource | null,
  io: IOResult,
  execNode: ExecutionNode,
): Promise<[null, IOResult, ExecutionNode]> {
  try {
    await pump(sink, Channel.STDOUT, stdout, io)
  } catch (err) {
    if (err instanceof PipeClosed) {
      // SIGPIPE keeps what the writer already said on stderr (`cat /missing
      // big > >(head -c 1)`), unless it answers itself (`tee -p`).
      await sendStderr(sink, io)
      if (!(await answerClosed(io, (channel, data) => sink.emit(channel, data)))) throw err
      execNode.exitCode = io.exitCode
    } else await failedRead(io, err, execNode)
  }
  if (io.output !== null) execNode.exitCode = io.exitCode
  await sendStderr(sink, io)
  return [null, io, execNode]
}

/** Write a statement's stderr to its sink, emptying it in the result. Mirrors Python's _send_stderr. */
async function sendStderr(sink: JobConsole, io: IOResult): Promise<void> {
  const stderr = await io.materializeStderr()
  if (stderr.byteLength > 0) {
    await sink.emit(Channel.STDERR, stderr)
    io.stderr = null
  }
}

/**
 * Where a job's output goes on from its own console, given up once the
 * job is killed. A promise cannot be cancelled, so a write that a stalled
 * reader holds, or that waits for a reader to take what waited for it,
 * would keep a killed job's runner (and its process slot) waiting; each
 * write races the job's signal instead. Python's cancelled task unwinds
 * at that await on its own.
 */
class JobCopy extends JobConsole {
  constructor(
    readonly target: JobConsole,
    readonly signal: AbortSignal,
  ) {
    super()
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await abortable(this.target.emit(channel, data), this.signal)
  }

  override async emitTo(stream: OwnedStream, data: Uint8Array): Promise<void> {
    await abortable(this.target.emitTo(stream, data), this.signal)
  }
}

/**
 * The streams a job started from `node` writes, as its shell hands them
 * on: stdout, stderr and the copies the shell holds (`3>&1`), after the
 * job's own redirects (`sleep 9 >/dev/null &`). A stream sent to a file
 * or closed is gone.
 */
function jobStreams(node: TSNodeLike, session: SessionState): Set<Channel | OwnedStream> {
  const fds = new Map<number, Channel | OwnedStream | null>([
    [1, Channel.STDOUT],
    [2, Channel.STDERR],
  ])
  for (const [fd, descriptor] of session.descriptors)
    if (fd > 2) fds.set(fd, descriptor.stream ?? null)
  if (nodeKind(node) === NodeKind.REDIRECT)
    for (const r of getRedirects(node)[1]) {
      if (r.target === FD_CLOSE) fds.delete(r.fd)
      else if (typeof r.target === 'number') fds.set(r.fd, fds.get(r.target) ?? null)
      else for (const fd of r.fd === FD_BOTH ? [1, 2] : [r.fd]) fds.set(fd, null)
    }
  const streams = new Set<Channel | OwnedStream>()
  for (const stream of fds.values()) if (stream !== null) streams.add(stream)
  return streams
}

/**
 * Whether a job is one program, as bash runs `cmd &` as the program
 * itself: a simple command whose word names neither a function nor a shell
 * builtin a runtime cannot take (`eval`, `source`), either of which keeps a
 * shell between the job and the program, and which the signal ends. `exec`
 * and `command` run the word after their options in place, so that word is
 * the one judged; `command -v` only looks it up. A word an expansion
 * spells, or one still quoting a character (`e\val`), is not known before
 * it runs, and words that run commands of their own (`$( )`) run them as
 * the job, so neither is one. Mirrors Python's `_one_program`.
 */
export function oneProgram(left: TSNodeLike, session: SessionState): boolean {
  return programWord(left, session) !== null
}

/** The word naming the program a job is, null when it is not one (`oneProgram`). */
export function programWord(left: TSNodeLike, session: SessionState): string | null {
  if (!simpleCommand(left)) return null
  const invocations = commandInvocations(left)
  const first = invocations[0]
  if (invocations.length !== 1 || first === undefined) return null
  let words = [first[0], ...first[1]]
  while (words[0] === 'exec' || words[0] === 'command') {
    const wrapper = words[0]
    words = words.slice(1)
    while (words[0]?.startsWith('-') === true) {
      if (wrapper === 'command' && /[vV]/.test(words[0])) return null
      words = words.slice(words[0] === '-a' ? 2 : 1)
    }
  }
  const head = words[0] ?? null
  if (
    head === null ||
    head.includes('\\') ||
    (SHELL_NAMES.has(head) && !CAPTURABLE_BUILTINS.has(head)) ||
    Object.hasOwn(session.functions, head)
  )
    return null
  return head
}

/**
 * Whether a job is one program a runtime past the workspace runs, which has
 * a pid of its own there. Mirrors Python's `_on_a_machine`.
 */
function onAMachine(left: TSNodeLike, context: EvaluationContext): boolean {
  const head = programWord(left, context.session)
  const routing = context.frame.routing
  if (head === null || routing === undefined) return false
  const runtime = Object.hasOwn(routing.bindings, head) ? routing.bindings[head] : routing.fallback
  return (
    runtime !== null &&
    runtime !== undefined &&
    (runtime as { reach?: string }).reach !== 'workspace'
  )
}

/**
 * Whether bash forks a statement as one program. The shell's own work (a
 * builtin, a function, a compound command) is not one, and a subshell, a
 * nested shell (`bash -c`) and a pipeline's stages are processes of their
 * own, each a shell that runs its own programs. Mirrors Python's _forked.
 */
function forked(node: TSNodeLike | null, session: SessionState): boolean {
  if (node === null || isBackgrounded(node)) return false
  if (node.type === NT.REDIRECTED_STATEMENT) return forked(getRedirects(node)[0], session)
  return node.type === NT.COMMAND && forks(node, session) && !nestedShell(node, session)
}

/**
 * Run one statement to the end of its output. A program its shell forks
 * (`sleep 3`) runs where a signal the shell ignores still stops it, whole, as
 * bash forks each with that signal back at its default: QUIT, which every
 * shell ignores, and INT, which a background job's does. The statement ends
 * with 128 plus the signal, and the shell goes on. A native program's signal
 * (`programSignaled`) counts for the statement that ran it only. Mirrors
 * Python's run_program.
 */
export async function runProgram(
  node: TSNodeLike,
  context: EvaluationContext,
  run: () => Promise<RedirectResult>,
  jobTable: JobTable | null = null,
  sink: JobConsole | null = null,
): Promise<RedirectResult> {
  currentCaller().process?.programSignaled(null)
  const shell = context.frame.shell
  if (shell === null || !forked(node, context.session)) return run()
  const outer = context.frame.abortSignal
  const [ran, signal] = await shell.program(async (stop) => {
    context.frame.abortSignal = outer === null ? stop : AbortSignal.any([outer, stop])
    // What the child runs is its own, which the signal stops with it.
    context.frame.shell = null
    try {
      return await run()
    } finally {
      context.frame.abortSignal = outer
      context.frame.shell = shell
    }
  })
  let result: RedirectResult
  if (signal === null) {
    result = ran
  } else {
    const code = 128 + signal
    if (node.type !== NT.COMMAND) context.session.pipeStatusPending = [code]
    recordStatus(context.session, code)
    result = [
      null,
      new IOResult({ exitCode: code }),
      new ExecutionNode({ command: node.text, exitCode: code }),
    ]
  }
  if (jobTable === null) {
    context.frame.reports.push(new Uint8Array())
    return result
  }
  const told = reportJobs(context, jobTable)
  if (told.length > 0) await tell(told, result[1], result[2], sink)
  return result
}

/**
 * Put the report of a child a statement reaped after the statement's stderr:
 * into the sink it writes to as it runs, or after the stderr it returns.
 * Mirrors Python's tell.
 */
export async function tell(
  report: Uint8Array,
  io: IOResult,
  execNode: ExecutionNode,
  sink: JobConsole | null,
): Promise<void> {
  if (sink === null) {
    const merged = concat([await io.materializeStderr(), report])
    io.stderr = merged
    execNode.stderr = merged
    return
  }
  await sendStderr(sink, io)
  await sink.emit(Channel.STDERR, report)
}

/**
 * bash's reports of the jobs its shell started that a signal ended since it
 * last told, as it tells once it reaped a child or waited: each once, and
 * the TERM, INT or PIPE that ended one untold. The signal is the one `kill`
 * stopped a job with, or the one that ended the native program a job's
 * status is. A substitution's shell tells of none. Mirrors Python's
 * report_jobs.
 */
export function reportJobs(context: EvaluationContext, jobTable: JobTable | null): Uint8Array {
  const session = context.session
  if (jobTable === null || session.processId === null || context.frame.substitution) {
    return new Uint8Array()
  }
  const told: string[] = []
  for (const job of jobTable.listJobs(sessionOf(session))) {
    const process = job.process ?? null
    if (job.reported || job.state === 'running' || process?.record.parent !== session.processId) {
      continue
    }
    const ended = job.signal ?? process.endedBy
    if (ended === null || ended < 1 || job.exitCode !== 128 + ended) continue
    const report = signalReport(
      shellVoice(),
      [[job.shownPid, job.exitCode, ended, job.command]],
      false,
    )
    if (report !== '') {
      job.reported = true
      told.push(report)
    }
  }
  return encodeText(told.join(''))
}

/**
 * Queue bash's report of a child its shell waited for that a signal ended
 * (`signalReport`), empty when it prints none, to follow the reaping
 * command's stderr with those of the shell's jobs. Each entry is a process
 * of the child, its status and the command it ran. Mirrors Python's
 * report_reaped.
 */
export function reportReaped(
  frame: ExecutionFrame,
  reaped: readonly (readonly [ProcessHandle, number, TSNodeLike])[],
): void {
  if (frame.substitution) return
  const listed = signalReported(reaped[reaped.length - 1]?.[0].endedBy ?? null)
  const processes = reaped.map(
    ([process, code, node]) =>
      [process.record.id.pid, code, process.endedBy, listed ? reportedCommand(node) : ''] as const,
  )
  frame.reports.push(encodeText(signalReport(shellVoice(), processes, true)))
}

/**
 * Start a shell the running one forks (a subshell, a pipeline stage, a
 * command substitution, a nested shell): a process in its session's
 * directory that ignores the signals every shell does. A fork past the
 * session's process limit fails as bash's does. `oneCommand` marks a shell
 * that runs one program, which runs as it (`oneProgram`). Mirrors Python's
 * start_shell.
 */
export function startShell(
  processes: ProcessTable,
  session: SessionState,
  command: string,
  run: ProcessRunner,
  parent: number | null,
  cancel: () => void,
  started?: (process: ProcessHandle) => void,
  oneCommand = false,
): ProcessHandle {
  try {
    return processes.start({
      sessionId: session.sessionId,
      command,
      cwd: PathSpec.fromStrPath(session.cwd),
      run,
      cancel,
      parent,
      limit: session.processes.max,
      ...(started === undefined ? {} : { started }),
      ignores: SHELL_IGNORED_SIGNALS,
      oneCommand,
    })
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EAGAIN')
      throw new ExitSignal(FORK_FAILED_STATUS, encodeText(FORK_FAILED))
    throw error
  }
}

export async function handleBackground(
  executeNode: ExecuteNodeFn,
  left: TSNodeLike,
  right: TSNodeLike | null,
  context: EvaluationContext,
  jobTable: JobTable,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  // The line's hand-off and the ledger it lives in. The claims the
  // line's pass made for the commands inside the job leave that
  // hand-off for one of the job's own before the job starts
  // (`Decisions.split`): its gates run after the line has returned, and
  // its grants have to stay reserved through the line's end whichever
  // way the line ends, a release for a question left waiting included.
  // The job's whole subtree runs on that hand-off, the lines it
  // evaluates included (the walker binds it into their entry point), and the
  // job revokes it when it ends.
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<RedirectResult> {
  const session = context.session
  const releaseProgram = retainPrograms([left])
  const childEvaluation = childContext(context)
  const bgSession = childEvaluation.session
  // How a job takes an INT or a QUIT, which its shell ignores: one program
  // ignores it too, and a shell that runs commands of its own (`{ sleep 3;
  // echo x; } &`) loses only the program it runs right now (`runProgram`). A
  // builtin or a function its shell runs (`f &`) ends with that program on
  // INT, as bash's shell does of an INT its child died of.
  const command = left.type === NT.REDIRECTED_STATEMENT ? getRedirects(left)[0] : left
  const piped = command !== null && command.type === NT.PIPELINE
  const oneCommand = command !== null && command.type === NT.COMMAND
  const ends = oneCommand && !forks(command, session)
  const inPlace = (oneCommand && !ends) || (command !== null && command.type === NT.SUBSHELL)
  const heldInputs = holdInputs(bgSession.openInputs())
  const dropHolds = async (): Promise<void> => {
    let failure: { error: unknown } | undefined
    while (heldInputs.length > 0) {
      try {
        await heldInputs.pop()?.lines.unhold()
      } catch (error) {
        if (failure !== undefined) logger.debug?.(`job: dropping a hold failed: ${String(error)}`)
        failure ??= { error }
      }
    }
    if (failure !== undefined) throw failure.error
  }
  inheritTraps(bgSession)
  const output = session.jobOutput ?? session.tty.jobs
  // A job is a shell of its own: what jobs it starts write into the
  // statement it runs, then where it writes.
  bgSession.jobOutput = new JobOutput(output)
  // A job is a child shell outside every loop: `{ break; } &` in a loop
  // refuses, as bash's does.
  const bgCallStack = (callStack ?? new CallStack()).fork(false, simpleCommand(left) ? null : true)
  const jobHanded =
    handed !== null && decisions !== null
      ? decisions.split(session.sessionId, handed, occurrenceOf(left, handed))
      : null

  const abort = new AbortController()
  // `kill %n` aborts this controller; the signal rides the forked
  // session so the job's whole subtree (builtins, mounts, runtimes)
  // observes the kill, merged with any enclosing job's channel. An
  // enclosing job's limit is not part of that channel: it aborts with a
  // CommandTimeoutError, which this job does not answer to, so a job runs
  // to its own limit as a line's deadline leaves the line's jobs alone.
  // The job stops listening once it ends or is killed, so a long-lived
  // job keeps nothing of the jobs it started.
  const enclosing = context.frame.abortSignal
  const inherited = new AbortController()
  const follow = (): void => {
    if (!(enclosing?.reason instanceof CommandTimeoutError)) inherited.abort(enclosing?.reason)
  }
  const unfollow = (): void => {
    enclosing?.removeEventListener('abort', follow)
  }
  if (enclosing?.aborted === true) follow()
  else enclosing?.addEventListener('abort', follow, { once: true, signal: abort.signal })
  const killed = AbortSignal.any([inherited.signal, abort.signal])
  // The job runs under the `@line` limit of the line that started it, from
  // its own start, its output included: past it the subtree is stopped as a
  // kill stops it, a write a reader holds included, and the job answers 124
  // and the line's message, as a line does.
  const expiry = new AbortController()
  const stopped = AbortSignal.any([killed, expiry.signal])
  childEvaluation.frame.abortSignal = stopped
  const cmdStrInner = left.text
  const runBg = async (job: JobHandle): Promise<[IOResult, ExecutionNode]> => {
    childEvaluation.frame.shell = inPlace ? null : job.process
    if (job.process !== null) job.process.pipeline = piped
    // What the job writes stays in its console and goes where its shell
    // writes as it is written: the terminal, or the substitution or pipe
    // it was started in.
    const console_ = new Tee(job.console, new JobCopy(output, stopped))
    const hold = { held: false, ended: false }
    const lineSink = currentCaller().refusals
    // The line still hears of every refusal; a question left waiting also
    // holds the job.
    const note = (refusal: Refusal): void => {
      hold.held ||= isPending(refusal)
      lineSink?.(refusal)
    }
    const run = async (stop: AbortSignal | null = null): Promise<[IOResult, ExecutionNode]> => {
      let stdout: ByteSource | null
      let io: IOResult
      let execNode: ExecutionNode
      try {
        // The sink is what makes compound bodies stream: each statement
        // writes as it finishes rather than the whole construct landing
        // at the end. The signal is what makes `kill` able to stop the
        // job at all, since a promise cannot be cancelled.
        const opts: ExecuteNodeOpts = {
          sink: console_,
          signal: AbortSignal.any([abort.signal, expiry.signal, ...(stop === null ? [] : [stop])]),
          lineHandle: new LineHandle(newLineId(), bgSession.sessionId, cmdStrInner),
          endsShell: true,
          jobTable: jobTable.child(),
        }
        if (jobHanded !== null) opts.handed = jobHanded
        ;[stdout, io, execNode] = await executeNode(left, childEvaluation, null, bgCallStack, opts)
      } catch (err) {
        if (err instanceof ExitSignal) {
          // A background job is its own shell: exit ends the job only, a
          // simple command the top shell forked with the status that shell
          // would exit with (`: ${U?} &` is 127, `{ : ${U?}; } &` and
          // `( : ${U?} & )` are 1).
          stdout = err.stdout ?? new Uint8Array()
          const status =
            simpleCommand(left) && !err.sourced && callStack?.subshell !== true
              ? err.exitCode
              : err.containedCode
          io = new IOResult({ exitCode: status, stderr: err.stderr })
          execNode = new ExecutionNode({
            command: cmdStrInner,
            stderr: err.stderr,
            exitCode: status,
          })
        } else if (err instanceof ReturnSignal) {
          stdout = err.stdout
          io = new IOResult({ exitCode: err.exitCode, stderr: err.stderr })
          execNode = new ExecutionNode({
            command: cmdStrInner,
            stderr: err.stderr,
            exitCode: err.exitCode,
          })
        } else {
          throw err
        }
      }
      // Drained inside the rebind: pumping the stream can still run
      // ops that read the ambient session.
      await pump(console_, Channel.STDOUT, stdout)
      const stderr = await io.materializeStderr()
      if (stderr.byteLength > 0) {
        await console_.emit(Channel.STDERR, stderr)
      }
      return [io, execNode]
    }
    const takingInterrupts = async (): Promise<[IOResult, ExecutionNode]> => {
      if (!ends || job.process === null) return run()
      const [ran, signal] = await job.process.program((stop) => {
        childEvaluation.frame.abortSignal = AbortSignal.any([stopped, stop])
        return run(stop)
      }, ENDING_SIGNALS)
      if (signal === null) return ran
      const code = 128 + signal
      return [
        new IOResult({ exitCode: code }),
        new ExecutionNode({ command: cmdStrInner, exitCode: code }),
      ]
    }
    const body = async (): Promise<[IOResult, ExecutionNode]> => {
      const seconds = childEvaluation.frame.lineTimeout
      const limit = seconds !== null && seconds > 0 ? seconds : null
      const expire = (): void => {
        if (limit === null) return
        job.process?.expire()
        expiry.abort(new CommandTimeoutError(LINE_NAME, limit))
      }
      const disarm = limit === null ? undefined : atDeadline(limit, expire)
      let result: [IOResult, ExecutionNode]
      try {
        result = await runWithDeadline(limit, expire, takingInterrupts, true)
      } catch (err) {
        // Past its own limit, or stopped by a command's own timeout, the job
        // answers as a line does, 124 and the message; a killed job ends as
        // killed.
        const timedOut =
          seconds !== null && expiry.signal.aborted
            ? new CommandTimeoutError(LINE_NAME, seconds)
            : err instanceof CommandTimeoutError
              ? err
              : null
        if (timedOut === null || abort.signal.aborted) throw err
        const msg = encodeText(`${timedOut.message}\n`)
        // The job's own console keeps the notice; the shell's output gets it
        // unless a reader that stopped reading holds it past the wait a
        // stopped job is given, so the job still ends.
        await job.console.emit(Channel.STDERR, msg)
        try {
          await abortable(
            output.emit(Channel.STDERR, msg),
            AbortSignal.any([killed, AbortSignal.timeout(STOP_WAIT_SECONDS * 1000)]),
          )
        } catch (err) {
          console.debug('job: its timeout notice found no reader', err)
        }
        result = [
          new IOResult({ exitCode: TIMEOUT_STATUS }),
          new ExecutionNode({ command: cmdStrInner, stderr: msg, exitCode: TIMEOUT_STATUS }),
        ]
      } finally {
        disarm?.()
      }
      hold.ended = hold.held || isPending(result[0].refusal)
      return result
    }
    // The job's own layer of the caller: its fork, so dispatcher and host
    // callbacks stay in it; its session writes, calls of the job's spent
    // at its end, not of the line it outlives; and a sink that tells the
    // line of every refusal. Without task isolation a frame the job bound
    // would reach every other task, after the line ended too, so there it
    // binds none; nested shell evaluations carry the walker's exact session
    // explicitly on both runtimes.
    const outer = currentCaller()
    const own: Caller = {
      ...outer,
      session: childEvaluation.session,
      evaluation: childEvaluation,
      call:
        jobHanded !== null && decisions !== null
          ? [decisions, jobHanded, session.sessionId]
          : outer.call,
      refusals: lineSink !== null ? note : null,
    }
    try {
      return await (asyncContextIsolatesTasks ? runWithCaller(own, body) : body())
    } finally {
      unfollow()
      releaseProgram()
      await bgSession.closeInputs()
      await dropHolds()

      if (jobHanded !== null && decisions !== null) {
        // A job that ended held on a question leaves its grants standing
        // for the retry, as a held line does; a killed or failed one spends
        // them.
        if (hold.ended) decisions.release(session.sessionId, jobHanded)
        else await decisions.revoke(session.sessionId, jobHanded)
      }
    }
  }

  const cmdStr = left.text
  // Non-interactive bash announces nothing on launch ("[1] <pid>" is
  // interactive-only); the job stays discoverable via $! and `jobs`.
  let job: JobHandle
  try {
    job = await jobTable.submit({
      command: cmdStr,
      run: runBg,
      abort,
      cwd: bgSession.cwd,
      sessionId: session.sessionId,
      parent: session.processId,
      limit: session.processes.max,
      simple: oneProgram(left, session),
      // A job whose runner never begins skips runBg's finally, so its
      // holds on readers go as its process ends.
      ended: () =>
        dropHolds().catch((err: unknown) => {
          logger.debug?.(`job: dropping its holds on readers failed: ${String(err)}`)
        }),
    })
  } catch (err) {
    unfollow()
    releaseProgram()
    await dropHolds()

    // A submission that fails (a console the table cannot build, a
    // session at its process cap) starts no runner, so nothing would ever
    // revoke the job's hand-off: its grants would stay reserved for good,
    // neither spent nor on offer to any later line.
    if (jobHanded !== null && decisions !== null) {
      await decisions.revoke(session.sessionId, jobHanded)
    }
    if ((err as { code?: unknown }).code === 'EAGAIN')
      throw new ExitSignal(FORK_FAILED_STATUS, encodeText(FORK_FAILED))
    throw err
  }
  bgSession.processId = job.process?.record.id.pid ?? null
  // `$!` is the program's own pid, once it has started and has one, and a
  // pipeline's the last stage's.
  if (job.process !== null && (piped || onAMachine(left, context)))
    await job.process.placed(RUN_START_WAIT_SECONDS)
  const lastStage = job.process?.stages.at(-1)
  const lastCommand =
    lastStage === undefined || command === null
      ? undefined
      : getPipelineStages(command).commands.at(-1)
  if (lastStage !== undefined && lastCommand !== undefined && onAMachine(lastCommand, context))
    await lastStage.placed(RUN_START_WAIT_SECONDS)
  session.lastBgJobId = job.lastPid
  if (session.jobWaits?.reaches(output, jobStreams(left, session)) === true)
    session.jobWaits.add(job)

  if (right === null) {
    const tree = new ExecutionNode({
      op: '&',
      exitCode: 0,
      children: [new ExecutionNode({ command: cmdStr, exitCode: 0 })],
    })
    return [null, new IOResult(), tree]
  }

  const [rightStdout, rightIo, rightExec] = await executeNode(right, context, stdin, callStack)
  const children = [new ExecutionNode({ command: cmdStr, exitCode: 0 }), rightExec]
  const tree = new ExecutionNode({
    op: '&',
    exitCode: rightIo.exitCode,
    children,
  })
  return [rightStdout, rightIo, tree]
}

/**
 * Run one statement of a compound body, as a job when it ends in `&`.
 *
 * The program loop and the subshell body read the `&` off the token
 * stream themselves; a loop body, an if/case arm, a brace group or a
 * function body holds named nodes only, so the statement is asked about
 * its own terminator. The launch is a statement in its own right and
 * answers with status 0, as in bash, so `false &` inside a body trips
 * neither `$?` nor `set -e`. A null `jobTable` means the caller wired no
 * job plane, which is a programming error once a `&` shows up, not a
 * reason to run it inline. `bound` is `fd0Binding` as the body started,
 * so an `exec <` in it replaces `stdin` for the statements after it; a
 * job still gets the body's own stdin.
 */
export function runStatement(
  executeNode: ExecuteNodeFn,
  node: TSNodeLike,
  context: EvaluationContext,
  stdin: ByteSource | null,
  bound: readonly [SharedInput | null, boolean],
  callStack: CallStack | null,
  jobTable: JobTable | null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<RedirectResult> {
  const session = context.session
  if (!isBackgrounded(node)) {
    return executeNode(node, context, statementStdin(session, stdin, bound), callStack)
  }
  if (jobTable === null) {
    throw new Error(`\`${node.text} &\` needs a job table; none was wired`)
  }
  return handleBackground(
    executeNode,
    node,
    null,
    context,
    jobTable,
    stdin,
    callStack,
    handed,
    decisions,
  )
}
