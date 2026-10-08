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
import { retainPrograms } from '../../shell/parse/program.ts'

import { ExecutionScope } from '../execution.ts'
import type { SharedInput } from '../../io/async_line_iterator.ts'
import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { CommandTimeoutError } from '../../commands/errors.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { FD_BOTH, FD_CLOSE, FORK_FAILED, FORK_FAILED_STATUS } from '../../shell/constants.ts'
import { ExitSignal, ReturnSignal } from '../../shell/errors.ts'
import { getRedirects, isBackgrounded } from '../../shell/helpers.ts'
import { NodeKind, nodeKind } from '../../shell/node_kind.ts'
import { type Job, JobStatus, type JobTable } from '../../shell/job_table/index.ts'
import { PipeConsole } from '../../shell/console/pipe.ts'
import { Channel, JobConsole, JobOutput, type OwnedStream, Tee } from '../../shell/console/index.ts'
import { isProgramInvocation, runWithEvaluation } from '../../context/session_context.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { abortable, mergeSignals } from '../abort.ts'
import type { SessionView } from '../../ops/types.ts'
import type { Decisions } from '../../policy/decisions.ts'
import type { HandOff } from '../../policy/types.ts'
import type { ProcessInfo, ProcessState } from '../../process/types.ts'
import type { ProcessView } from '../../process/view.ts'
import { UNKNOWN_NAME } from '../../commands/builtin/utils/identity.ts'
import { gnuStrftime } from '../../commands/builtin/utils/strftime.ts'
import { LOCAL_ZONE, type Zone, zoneFromEnv } from '../../utils/timezone.ts'
import type { SessionState } from '../session/session.ts'
import { occurrenceOf } from '../node/occurrence.ts'
import { scanOptions } from './builtins/getopt.ts'
import { failedRead, statementStdin } from './statement.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { ExecutionNode } from '../types.ts'
import { inheritTraps } from './traps.ts'
import { encodeText } from '../../shell/bytes.ts'
import type { ExecuteNodeOpts, ExecuteNodeFn } from './command/types.ts'

export type JobHandlerResult = [ByteSource | null, IOResult, ExecutionNode]

/**
 * Send a command's output to a console as chunks arrive.
 *
 * Consuming the stream piece by piece rather than materializing it whole
 * is what lets a reader watch a running job. A command that computes its
 * output eagerly still lands in one chunk, because there was nothing to
 * observe before it finished. A pipe is drained before the next chunk is
 * pulled, so a reader that closed stops the source before it fetches more.
 */
export async function pump(
  console_: JobConsole,
  channel: Channel,
  stream: ByteSource | null,
): Promise<void> {
  if (stream === null) return
  if (stream instanceof Uint8Array) {
    if (stream.byteLength > 0) await console_.emit(channel, stream)
    return
  }
  for await (const chunk of stream) {
    if (chunk.byteLength > 0) await console_.emit(channel, chunk)
    if (!(console_ instanceof PipeConsole)) continue
    await console_.drain()
    if (console_.closedReader) return
  }
}

/**
 * Write a finished statement's returned output to a sink, its stdout before
 * its stderr, since one command keeps no order between them; what it already
 * wrote there as it ran (a function body, a redirected group) came first. A
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
    await pump(sink, Channel.STDOUT, stdout)
  } catch (err) {
    await failedRead(io, err, execNode)
  }
  const stderr = await io.materializeStderr()
  if (stderr.byteLength > 0) {
    await sink.emit(Channel.STDERR, stderr)
    io.stderr = null
  }
  return [null, io, execNode]
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

export async function handleBackground(
  executeNode: ExecuteNodeFn,
  left: TSNodeLike,
  right: TSNodeLike | null,
  context: EvaluationContext,
  jobTable: JobTable,
  agentId: string | null,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
  // The line's hand-off and the ledger it lives in. The claims the
  // line's pass made for the commands inside the job leave that
  // hand-off for one of the job's own before the job starts
  // (`Decisions.split`): its gates run after the line has returned, and
  // its grants have to stay reserved through the line's end whichever
  // way the line ends, a release for a question left waiting included.
  // The job's whole subtree runs on that hand-off, the lines it
  // evaluates included (the walker binds it into their door), and the
  // job revokes it when it ends.
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<JobHandlerResult> {
  const session = context.session
  const releaseProgram = retainPrograms([left])
  const childEvaluation = childContext(context)
  const bgSession = childEvaluation.session
  inheritTraps(bgSession)
  const output = session.jobOutput ?? session.tty.jobs
  // A job is a shell of its own: what jobs it starts write into the
  // statement it runs, then where it writes.
  bgSession.jobOutput = new JobOutput(output)
  // A job is a child shell outside every loop: `{ break; } &` in a loop
  // refuses, as bash's does.
  const bgCallStack = (callStack ?? new CallStack()).fork(false)
  const jobHanded =
    handed !== null && decisions !== null
      ? decisions.split(session.sessionId, handed, occurrenceOf(left, handed))
      : null

  const abort = new AbortController()
  // `kill %n` aborts this controller; the signal rides the forked
  // session so the job's whole subtree (builtins, mounts, runtimes)
  // observes the kill, merged with any enclosing job's channel.
  const killed = mergeSignals(context.frame.abortSignal, abort.signal) ?? abort.signal
  childEvaluation.frame.abortSignal = killed
  const cmdStrInner = left.text
  const runBg = async (job: Job): Promise<[IOResult, ExecutionNode]> => {
    // What the job writes stays in its console and goes where its shell
    // writes as it is written: the terminal, or the substitution or pipe
    // it was started in.
    const console_ = new Tee(job.console, new JobCopy(output, killed))
    const body = async (): Promise<[IOResult, ExecutionNode]> => {
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
          signal: abort.signal,
          executionScope: new ExecutionScope(),
          endsShell: true,
        }
        if (jobHanded !== null) opts.handed = jobHanded
        ;[stdout, io, execNode] = await executeNode(left, childEvaluation, null, bgCallStack, opts)
      } catch (err) {
        if (err instanceof CommandTimeoutError) {
          const msg = encodeText(`${err.message}\n`)
          stdout = new Uint8Array()
          io = new IOResult({ exitCode: 124, stderr: msg })
          execNode = new ExecutionNode({ command: cmdStrInner, stderr: msg, exitCode: 124 })
        } else if (err instanceof ExitSignal) {
          // A background job is its own shell: exit ends the job only.
          stdout = err.stdout ?? new Uint8Array()
          io = new IOResult({ exitCode: err.containedCode, stderr: err.stderr })
          execNode = new ExecutionNode({
            command: cmdStrInner,
            stderr: err.stderr,
            exitCode: err.containedCode,
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
    // Task-local bindings keep op doors and host callbacks in the job's
    // fork. The fallback cannot attribute ambient reads to a task, so
    // it keeps the outer binding; nested shell evaluations carry the
    // walker's exact session explicitly on both runtimes.
    try {
      return await (asyncContextIsolatesTasks ? runWithEvaluation(childEvaluation, body) : body())
    } finally {
      releaseProgram()

      if (jobHanded !== null && decisions !== null) {
        await decisions.revoke(session.sessionId, jobHanded)
      }
    }
  }

  const cmdStr = left.text
  // Non-interactive bash announces nothing on launch ("[1] <pid>" is
  // interactive-only); the job stays discoverable via $! and `jobs`.
  let job: Job
  try {
    job = jobTable.submit({
      command: cmdStr,
      run: runBg,
      abort,
      cwd: bgSession.cwd,
      agent: agentId ?? '',
      sessionId: session.sessionId,
      parentPid: session.processId,
      limit: session.processes.max,
    })
  } catch (err) {
    releaseProgram()

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
  bgSession.processId = job.process?.info.pid ?? null
  session.lastBgJobId = job.pid
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
  agentId: string | null,
  handed: HandOff | null = null,
  decisions: Decisions | null = null,
): Promise<JobHandlerResult> {
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
    agentId,
    stdin,
    callStack,
    handed,
    decisions,
  )
}

const WAIT_USAGE = 'wait: usage: wait [-fn] [-p var] [id ...]'
const DISOWN_USAGE = 'disown: usage: disown [-h] [-ar] [jobspec ... | pid ...]'
const JOB_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function jobResult(cmdStr: string, msg: string, code: number): JobHandlerResult {
  const err = encodeText(msg)
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err }),
  ]
}

/**
 * The job list a builtin reads: the calling session's, or the shared
 * empty id when it runs with no session (a bare table in a test).
 */
function sessionOf(session: SessionState | null): string {
  return session?.sessionId ?? ''
}

/** The managed runners `ps` and numeric `kill` reach, scoped by the session's profile. */
function processView(jobTable: JobTable, session: SessionState | null): ProcessView {
  return session === null
    ? jobTable.processes.view('')
    : jobTable.processes.view(session.sessionId, () => session.processes)
}

/** The job whose number is `jobId`, the one `%N` names. */
function jobNumbered(jobs: readonly Job[], jobId: number): Job | null {
  return jobs.find((j) => j.id === jobId) ?? null
}

/**
 * The job a `wait`/`disown` operand names, or bash's refusal. A `%N`
 * spec naming no job is `no such job`; a bare number is a managed PID,
 * also returned by `$!`, so an unknown one is `pid N is not a child of
 * this shell`. Anything else is `not a pid or valid job spec`.
 */
function resolveSpec(jobs: readonly Job[], spec: string): [Job | null, string] {
  if (spec.startsWith('%')) {
    const raw = spec.slice(1)
    const job = /^[0-9]+$/.test(raw) ? jobNumbered(jobs, Number(raw)) : null
    return [job, job !== null ? '' : `${spec}: no such job`]
  }
  if (/^[0-9]+$/.test(spec)) {
    const job = jobs.find((j) => j.pid === Number(spec)) ?? null
    return [job, job !== null ? '' : `pid ${spec} is not a child of this shell`]
  }
  return [null, `\`${spec}': not a pid or valid job spec`]
}

/** Block until the first of several jobs ends, and return it. */
async function waitFirst(jobTable: JobTable, jobs: Job[]): Promise<Job> {
  for (const job of jobs) {
    if (job.status !== JobStatus.RUNNING) return await jobTable.wait(job.id, job.sessionId)
  }
  const races = jobs.map(async (job) => await jobTable.wait(job.id, job.sessionId))
  return await Promise.race(races)
}

/**
 * Report one finished job's status, and reap it. Its output already went
 * where its shell writes as it was written.
 */
function reaped(jobTable: JobTable, job: Job, cmdStr: string): JobHandlerResult {
  // Reaped like GNU bash reaps a job waited on by id, so a later bare
  // `wait` does not answer for it again.
  jobTable.reap(job.id, job.sessionId)
  return [
    null,
    new IOResult({ exitCode: job.exitCode }),
    new ExecutionNode({ command: cmdStr, exitCode: job.exitCode }),
  ]
}

/**
 * Wait for background jobs, with bash's option surface. A job's output
 * went where its shell writes as it was written, so `wait` prints none,
 * as bash's does. Bare `wait` joins every job; `wait ID...` joins those
 * and answers the last one's status; `-n` joins the first of the given jobs
 * (or of all) to finish, 127 when there is nothing to wait for; `-p VAR`
 * stores the id of the job whose status is answered, unsetting VAR when
 * none is (which is the bare form, since it reports no one job); `-f` is
 * accepted, since a mirage job cannot stop, only end.
 *
 * `-p` stores the managed PID, matching `$!` and `jobs -p`.
 */
export async function handleWait(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  view: SessionView | null = null,
  signal?: AbortSignal,
): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  let nextJob = false
  let varName: string | null = null
  const specs: string[] = []
  let i = 1
  while (i < parts.length) {
    const word = parts[i] ?? ''
    if (specs.length > 0 || !word.startsWith('-') || word === '-') {
      specs.push(word)
      i++
      continue
    }
    if (word === '--') {
      specs.push(...parts.slice(i + 1))
      break
    }
    let j = 1
    let bad: string | null = null
    while (j < word.length) {
      const ch = word[j] ?? ''
      if (ch === 'n') nextJob = true
      else if (ch === 'f') {
        // A mirage job cannot stop, only end, so `-f` is already true.
      } else if (ch === 'p') {
        const rest = word.slice(j + 1)
        if (rest !== '') varName = rest
        else if (i + 1 < parts.length) {
          i++
          varName = parts[i] ?? ''
        } else {
          return jobResult(
            cmdStr,
            `bash: wait: -p: option requires an argument\n${WAIT_USAGE}\n`,
            2,
          )
        }
        break
      } else {
        bad = ch
        break
      }
      j++
    }
    if (bad !== null) {
      return jobResult(cmdStr, `bash: wait: -${bad}: invalid option\n${WAIT_USAGE}\n`, 2)
    }
    i++
  }
  if (varName !== null) {
    if (!JOB_IDENTIFIER.test(varName)) {
      return jobResult(cmdStr, `bash: wait: \`${varName}': not a valid identifier\n`, 1)
    }
    if (view?.isReadonly(varName) === true) {
      return jobResult(cmdStr, `bash: wait: ${varName}: cannot unset: readonly variable\n`, 1)
    }
    if (view !== null) await view.unset(varName)
  }
  const errors: string[] = []
  const picked: Job[] = []
  const visible = jobTable.listJobs(sid)
  for (const spec of specs) {
    const [job, refusal] = resolveSpec(visible, spec)
    if (job === null) {
      errors.push(`bash: wait: ${refusal}`)
      continue
    }
    picked.push(job)
  }
  const errText = errors.length > 0 ? errors.join('\n') + '\n' : ''
  const errBytes = errText !== '' ? encodeText(errText) : null
  if (nextJob) {
    const candidates = specs.length > 0 ? picked : visible
    if (candidates.length === 0) {
      return [
        null,
        new IOResult({ exitCode: 127, stderr: errBytes }),
        new ExecutionNode({ command: cmdStr, exitCode: 127 }),
      ]
    }
    const job = await abortable(waitFirst(jobTable, candidates), signal)
    if (varName !== null && view !== null) await view.set(varName, String(job.pid))
    const [stdout, io, node] = reaped(jobTable, job, cmdStr)
    if (errBytes !== null) io.stderr = errBytes
    return [stdout, io, node]
  }
  if (specs.length === 0) {
    await abortable(jobTable.waitAll(sid), signal)
    jobTable.popCompleted(sid)
    return [null, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
  }
  if (picked.length === 0) {
    // Every spec was refused: bash answers 127 for a job it cannot find
    // and 1 for a word that is not a spec at all, the last one deciding.
    const last = errors[errors.length - 1] ?? ''
    const code = last.endsWith('not a pid or valid job spec') ? 1 : 127
    return jobResult(cmdStr, errText, code)
  }
  let lastCode = 0
  let lastJob: Job | null = null
  for (const job of picked) {
    const finished = await abortable(jobTable.wait(job.id, sid), signal)
    const [, io] = reaped(jobTable, finished, cmdStr)
    lastCode = io.exitCode
    lastJob = finished
  }
  // `wait id1 id2` answers with the last id's status, so `-p` names that
  // same job however many were waited for. Only the no-operand form
  // leaves the variable unset, since it reports no one job.
  if (varName !== null && view !== null && lastJob !== null) {
    await view.set(varName, String(lastJob.pid))
  }
  return [
    null,
    new IOResult({ exitCode: lastCode, stderr: errBytes }),
    new ExecutionNode({ command: cmdStr, exitCode: lastCode }),
  ]
}

/**
 * Drop jobs from the table without stopping them. No operand means the
 * current job (the newest), `-a` every job, `-r` the running ones, and
 * `%N`/`N` specs name jobs; `-h` marks a job to survive SIGHUP and leaves
 * it in the table, a no-op here since no hangup is ever delivered. A spec
 * naming no job is `no such job`, exit 1, and the others still drop.
 */
export function handleDisown(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): JobHandlerResult {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  const scan = scanOptions(parts.slice(1), 'arh')
  if (scan.bad !== null) {
    return jobResult(cmdStr, `bash: disown: ${scan.bad}: invalid option\n${DISOWN_USAGE}\n`, 2)
  }
  const allJobs = scan.letters.includes('a')
  const runningOnly = scan.letters.includes('r')
  const keep = scan.letters.includes('h')
  const specs = scan.operands
  let targets: Job[] = []
  const errors: string[] = []
  const jobs = jobTable.listJobs(sid)
  if (specs.length > 0) {
    for (const spec of specs) {
      const [job] = resolveSpec(jobs, spec)
      if (job === null) {
        errors.push(`bash: disown: ${spec}: no such job`)
        continue
      }
      targets.push(job)
    }
  } else if (allJobs || runningOnly) {
    targets = runningOnly ? jobs.filter((j) => j.status === JobStatus.RUNNING) : jobs
  } else {
    const current = jobs[jobs.length - 1]
    if (current === undefined) {
      return jobResult(cmdStr, 'bash: disown: current: no such job\n', 1)
    }
    targets = [current]
  }
  if (!keep) {
    for (const job of targets) jobTable.disown(job.id, sid)
  }
  const err = errors.length > 0 ? encodeText(errors.join('\n') + '\n') : null
  const code = errors.length > 0 ? 1 : 0
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({
      command: cmdStr,
      exitCode: code,
      ...(err !== null ? { stderr: err } : {}),
    }),
  ]
}

/**
 * Foreground a background job: print its command line, then block on it
 * and answer its exit code. Its output goes where it always went, as it
 * is written, so the command line goes out first: to `sink`, where the
 * statement writes, before the job's next bytes. With no operand it takes
 * the newest running job, which is bash's current job; when none runs, it
 * takes the newest finished one, as `fg %N` would.
 */
export async function handleFg(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
  signal?: AbortSignal,
  sink?: JobConsole,
): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  const jobs = jobTable.listJobs(sid)
  let target: Job
  if (parts.length <= 1) {
    const current = jobs.filter((j) => j.status === JobStatus.RUNNING).at(-1) ?? jobs.at(-1)
    if (current === undefined) {
      const err = encodeText('bash: fg: current: no such job\n')
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
      ]
    }
    target = current
  } else {
    const raw = (parts[1] ?? '').replace(/^%+/, '')
    const jobId = Number(raw)
    const numbered = Number.isInteger(jobId) ? jobNumbered(jobs, jobId) : null
    if (numbered === null) {
      const err = encodeText(`bash: fg: ${parts[1] ?? ''}: no such job\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
      ]
    }
    target = numbered
  }
  const header = encodeText(target.command + '\n')
  if (sink !== undefined) await sink.emit(Channel.STDOUT, header)
  const job = await abortable(jobTable.wait(target.id, sid), signal)
  jobTable.reap(target.id, sid)
  return [
    sink === undefined ? header : null,
    new IOResult({ exitCode: job.exitCode }),
    new ExecutionNode({ command: cmdStr, exitCode: job.exitCode }),
  ]
}

const KILL_USAGE =
  'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]'

// The signals a managed runner answers besides the probe (0). Each one ends
// the runner through its cancellation channel, so the waited status is the
// managed cancellation's (137) whichever was sent. Stop, continue and the
// user signals have no managed meaning and are refused as bash refuses a
// name it does not know.
const KILL_SIGNALS: Readonly<Record<string, number>> = {
  HUP: 1,
  INT: 2,
  QUIT: 3,
  KILL: 9,
  TERM: 15,
}

// The largest PID operand kill and ps read as a number: the bound both hosts
// hold exactly (bash's own is intmax_t).
const MAX_PID_OPERAND = Number.MAX_SAFE_INTEGER

/** bash's sigspec: a number, or a name with or without SIG, any case. */
function signalNumber(spec: string): number | null {
  if (/^[0-9]+$/.test(spec)) {
    const number = Number(spec)
    return number === 0 || Object.values(KILL_SIGNALS).includes(number) ? number : null
  }
  const name = spec.toUpperCase()
  return KILL_SIGNALS[name.startsWith('SIG') ? name.slice(3) : name] ?? null
}

/** The managed PID one kill operand names, or bash's refusal. */
function killPid(jobs: readonly Job[], operand: string): [number | null, string] {
  if (operand === '') return [null, "`': not a pid or valid job spec"]
  if (operand.startsWith('%')) {
    const raw = operand.slice(1)
    const job = /^[0-9]+$/.test(raw) ? jobNumbered(jobs, Number(raw)) : null
    return job !== null ? [job.pid, ''] : [null, `${operand}: no such job`]
  }
  const digits = operand.startsWith('-') ? operand.slice(1) : operand
  if (!/^[0-9]+$/.test(digits) || Number(digits) > MAX_PID_OPERAND)
    return [null, `${operand}: arguments must be process or job IDs`]
  return [Number(operand), '']
}

/**
 * Signal managed runners with bash's kill surface. The signal comes from
 * `-s`/`-n`, or from the first `-sigspec`; `0` probes and every other
 * signal cancels the runner. Every operand is tried and each failure is
 * named in bash's words; the status is 0 when any operand was signalled,
 * as bash's is. A job spec is `%N`; a negative number is a process group,
 * which no managed runner leads.
 */
export async function handleKill(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  let signal = KILL_SIGNALS.TERM ?? 15
  let words = parts.slice(1)
  let sawSignal = false
  // The program (`xargs kill`) keeps its bare voice.
  const voice = session !== null && isProgramInvocation(session) ? '' : 'bash: '
  while (words.length > 0) {
    const word = words[0] ?? ''
    let spec: string
    if (word === '-s' || word === '-n') {
      if (words.length < 2)
        return jobResult(cmdStr, `${voice}kill: ${word}: option requires an argument\n`, 1)
      spec = words[1] ?? ''
      words = words.slice(2)
    } else if (word === '--') {
      words = words.slice(1)
      break
    } else if (word === '-?') {
      return jobResult(cmdStr, `${KILL_USAGE}\n`, 2)
    } else if (word.startsWith('-') && word.length > 1 && !sawSignal) {
      spec = word.slice(1)
      words = words.slice(1)
      sawSignal = true
    } else break
    const number = signalNumber(spec)
    if (number === null)
      return jobResult(cmdStr, `${voice}kill: ${spec}: invalid signal specification\n`, 1)
    signal = number
  }
  if (words.length === 0) return jobResult(cmdStr, `${KILL_USAGE}\n`, 2)
  const processes = processView(jobTable, session)
  const errors: string[] = []
  let signalled = false
  for (const operand of words) {
    const jobs = jobTable.listJobs(sid)
    const [pid, refusal] = killPid(jobs, operand)
    if (pid === null) {
      errors.push(`${voice}kill: ${refusal}`)
      continue
    }
    let found: boolean
    try {
      if (signal === 0) found = processes.probe(pid)
      else {
        found = processes.terminate(pid)
        const job = jobs.find((j) => j.pid === pid)
        if (found && job !== undefined) await jobTable.kill(job.id, sid)
      }
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EPERM') throw err
      errors.push(`${voice}kill: (${String(pid)}) - Operation not permitted`)
      continue
    }
    if (!found) {
      errors.push(`${voice}kill: (${String(pid)}) - No such process`)
      continue
    }
    signalled = true
  }
  const code = signalled ? 0 : 1
  const stderr = errors.length > 0 ? encodeText(errors.join('\n') + '\n') : null
  return [
    null,
    new IOResult({ exitCode: code, stderr }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: stderr ?? new Uint8Array() }),
  ]
}

const JOBS_FLAGS: ReadonlySet<string> = new Set('lnprs')
const JOBS_USAGE = 'jobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]'

/** One `jobs` line; `-l` includes the managed PID. */
function jobRow(job: Job, long: boolean): string {
  const id = job.id.toString()
  return long
    ? `[${id}] ${String(job.pid)} ${job.status} ${job.command}`
    : `[${id}] ${job.status} ${job.command}`
}

/**
 * List jobs, with bash's flags applied to mirage's row shape.
 *
 * `-p` prints the managed PID; `-s` lists nothing because suspended
 * processes are unsupported. `-r` keeps running jobs, `-l` adds the PID, and
 * `-n` lists only the jobs whose status changed since the last `jobs`
 * (which is every completed one not yet reaped, since reaping is what a
 * listing does). A jobspec operand (`%2` or `2`) filters to that job;
 * one that names no job is `no such job`, exit 1. `-x` is not carried,
 * and an unknown letter is GNU's usage line, exit 2.
 */
export function handleJobs(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): JobHandlerResult {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  const flags = new Set<string>()
  const specs: string[] = []
  for (const word of parts.slice(1)) {
    if (word.startsWith('-') && word.length > 1 && specs.length === 0) {
      if (word === '--') continue
      const bad = Array.from(word.slice(1)).find((c) => !JOBS_FLAGS.has(c))
      if (bad !== undefined) {
        const err = encodeText(`bash: jobs: -${bad}: invalid option\n${JOBS_USAGE}\n`)
        return [
          null,
          new IOResult({ exitCode: 2, stderr: err }),
          new ExecutionNode({ command: cmdStr, exitCode: 2, stderr: err }),
        ]
      }
      for (const c of word.slice(1)) flags.add(c)
    } else {
      specs.push(word)
    }
  }
  let jobs = jobTable.listing(sid)
  if (specs.length > 0) {
    const picked: Job[] = []
    for (const spec of specs) {
      const raw = spec.replace(/^%+/, '')
      const job = /^\d+$/.test(raw) ? jobNumbered(jobs, Number(raw)) : null
      if (job === null) {
        const err = encodeText(`bash: jobs: ${spec}: no such job\n`)
        return [
          null,
          new IOResult({ exitCode: 1, stderr: err }),
          new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
        ]
      }
      picked.push(job)
    }
    jobs = picked
  }
  if (flags.has('r')) jobs = jobs.filter((j) => j.status === JobStatus.RUNNING)
  if (flags.has('s')) jobs = []
  if (flags.has('n')) jobs = jobs.filter((j) => j.status !== JobStatus.RUNNING)
  const lines = flags.has('p')
    ? jobs.map((j) => String(j.pid))
    : jobs.map((j) => jobRow(j, flags.has('l')))
  jobTable.popCompleted(sid)
  const out = lines.length > 0 ? encodeText(`${lines.join('\n')}\n`) : new Uint8Array()
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}

// procps-ng 4.0.4's usage block, printed under every option error.
const PS_USAGE =
  '\nUsage:\n ps [options]\n\n' +
  " Try 'ps --help <simple|list|output|threads|misc|all>'\n" +
  "  or 'ps --help <s|l|o|t|m|a>'\n" +
  ' for additional help text.\n\n' +
  'For more details see ps(1).\n'

// procps-ng 4.0.4's -o keys: header, width, right alignment and the fact
// `psCell` renders; accounting a runner lacks prints procps's none.
const PS_COLUMNS: Readonly<Record<string, readonly [string, number, boolean, string]>> = {
  pid: ['PID', 7, true, 'pid'],
  tgid: ['TGID', 7, true, 'pid'],
  lwp: ['LWP', 7, true, 'pid'],
  spid: ['SPID', 7, true, 'pid'],
  tid: ['TID', 7, true, 'pid'],
  ppid: ['PPID', 7, true, 'ppid'],
  pgid: ['PGID', 7, true, 'pgid'],
  pgrp: ['PGRP', 7, true, 'pgid'],
  sid: ['SID', 7, true, 'sid'],
  sess: ['SESS', 7, true, 'sid'],
  tpgid: ['TPGID', 7, true, 'tpgid'],
  stat: ['STAT', 4, false, 'stat'],
  state: ['S', 1, false, 'state'],
  s: ['S', 1, false, 'state'],
  cmd: ['CMD', 27, false, 'args'],
  args: ['COMMAND', 27, false, 'args'],
  command: ['COMMAND', 27, false, 'args'],
  comm: ['COMMAND', 15, false, 'comm'],
  ucmd: ['CMD', 15, false, 'comm'],
  ucomm: ['COMMAND', 15, false, 'comm'],
  user: ['USER', 8, false, 'user'],
  euser: ['EUSER', 8, false, 'user'],
  uname: ['USER', 8, false, 'user'],
  ruser: ['RUSER', 8, false, 'user'],
  suser: ['SUSER', 8, false, 'user'],
  fuser: ['FUSER', 8, false, 'user'],
  uid: ['UID', 5, true, 'user'],
  euid: ['EUID', 5, true, 'user'],
  ruid: ['RUID', 5, true, 'user'],
  suid: ['SUID', 5, true, 'user'],
  fuid: ['FUID', 5, true, 'user'],
  gid: ['GID', 5, true, 'group'],
  egid: ['EGID', 5, true, 'group'],
  rgid: ['RGID', 5, true, 'group'],
  group: ['GROUP', 8, false, 'group'],
  egroup: ['EGROUP', 8, false, 'group'],
  rgroup: ['RGROUP', 8, false, 'group'],
  tty: ['TT', 8, false, 'tty'],
  tt: ['TT', 8, false, 'tty'],
  tname: ['TTY', 8, false, 'tty'],
  time: ['TIME', 8, true, 'time'],
  cputime: ['TIME', 8, true, 'time'],
  cputimes: ['TIME', 8, true, 'zero'],
  etime: ['ELAPSED', 11, true, 'etime'],
  etimes: ['ELAPSED', 7, true, 'etimes'],
  lstart: ['STARTED', 24, true, 'lstart'],
  start: ['STARTED', 8, true, 'start'],
  start_time: ['START', 5, false, 'stime'],
  stime: ['STIME', 5, false, 'stime'],
  bsdstart: ['START', 6, true, 'bsdstart'],
  rss: ['RSS', 5, true, 'zero'],
  rssize: ['RSS', 5, true, 'zero'],
  rsz: ['RSZ', 5, true, 'zero'],
  vsz: ['VSZ', 6, true, 'zero'],
  vsize: ['VSZ', 6, true, 'zero'],
  sz: ['SZ', 5, true, 'zero'],
  trs: ['TRS', 4, true, 'zero'],
  drs: ['DRS', 5, true, 'zero'],
  dsiz: ['DSIZ', 4, true, 'zero'],
  size: ['SIZE', 5, true, 'zero'],
  pss: ['PSS', 5, true, 'zero'],
  uss: ['USS', 5, true, 'zero'],
  maj_flt: ['MAJFL', 6, true, 'zero'],
  min_flt: ['MINFL', 6, true, 'zero'],
  majflt: ['MAJFLT', 6, true, 'zero'],
  minflt: ['MINFLT', 6, true, 'zero'],
  '%cpu': ['%CPU', 4, true, 'percent'],
  pcpu: ['%CPU', 4, true, 'percent'],
  '%mem': ['%MEM', 4, true, 'percent'],
  pmem: ['%MEM', 4, true, 'percent'],
  c: ['C', 2, true, 'zero'],
  cp: ['CP', 3, true, 'zero'],
  ni: ['NI', 3, true, 'zero'],
  nice: ['NI', 3, true, 'zero'],
  pri: ['PRI', 3, true, 'pri'],
  priority: ['PRI', 3, true, 'priority'],
  opri: ['PRI', 3, true, 'opri'],
  rtprio: ['RTPRIO', 6, true, 'dash'],
  cls: ['CLS', 3, true, 'cls'],
  class: ['CLS', 3, false, 'cls'],
  policy: ['POL', 3, false, 'cls'],
  psr: ['PSR', 3, true, 'zero'],
  nlwp: ['NLWP', 4, true, 'one'],
  thcount: ['THCNT', 5, true, 'one'],
  f: ['F', 1, false, 'zero'],
  flag: ['F', 1, false, 'zero'],
  flags: ['F', 1, false, 'zero'],
  wchan: ['WCHAN', 6, false, 'dash'],
  nwchan: ['WCHAN', 6, true, 'dash'],
  label: ['LABEL', 31, false, 'dash'],
}

// The fixed answers for a runner: what procps prints for a process on no
// terminal, never scheduled away from the default policy and priority.
const PS_FIXED: Readonly<Record<string, string>> = {
  tpgid: '-1',
  tty: '?',
  time: '00:00:00',
  zero: '0',
  one: '1',
  percent: '0.0',
  pri: '19',
  priority: '20',
  opri: '80',
  dash: '-',
  cls: 'TS',
}

// A runner's state letter: live, being cancelled (still unwinding), or exited
// and not yet reaped.
const PS_STATES: Readonly<Record<ProcessState, string>> = {
  running: 'R',
  stopping: 'R',
  exited: 'Z',
}

// Letters that select every process: SysV -e/-A/-a/-x, BSD a/x.
const PS_ALL = new Set(['e', 'A', 'a', 'x'])

/** What a ps line selects and prints. */
interface PsOptions {
  readonly pids: ReadonlySet<number>
  readonly all: boolean
  readonly columns: readonly (readonly [string, string])[]
}

/** One `-p` list, refused in procps's words. */
function psPids(value: string, option: string): number[] {
  const tokens = value.split(/[\s,]+/).filter((t) => t !== '')
  if (tokens.length === 0) throw new Error(`list of process IDs must follow ${option}`)
  return tokens.map((token) => {
    if (!/^[+-]?[0-9]+$/.test(token)) throw new Error('process ID list syntax error')
    const number = Number(token)
    if (number <= 0 || number > MAX_PID_OPERAND) throw new Error('process ID out of range')
    return number
  })
}

/** One `-o` list: `key` or `key=header`, refused in procps's words. */
function psColumns(value: string, option: string): [string, string][] {
  if (value.trim() === '') throw new Error(`format specification must follow ${option}`)
  const columns: [string, string][] = []
  for (const item of value.split(',')) {
    if (item.trim() === '') throw new Error('improper format list')
    for (const token of item.split(/\s+/).filter((t) => t !== '')) {
      const equal = token.indexOf('=')
      const key = equal < 0 ? token : token.slice(0, equal)
      const column = PS_COLUMNS[key]
      if (column === undefined) throw new Error(`unknown user-defined format specifier "${key}"`)
      columns.push([key, equal < 0 ? column[0] : token.slice(equal + 1)])
    }
  }
  return columns
}

/**
 * Parse the procps selection and output options a runner answers: SysV
 * letters after one dash, BSD letters with none, and the `--pid`/`--format`
 * long forms; `-p` and `-o` repeat and accumulate. `-f` and BSD `u`/`w`/`f`
 * pick a layout the managed rows do not have, so they leave the compact one.
 */
function parsePs(words: string[]): PsOptions {
  const pids = new Set<number>()
  const columns: [string, string][] = []
  let all = false
  let at = 0
  while (at < words.length) {
    const word = words[at++] ?? ''
    if (word.startsWith('--')) {
      const equal = word.indexOf('=')
      const option = equal < 0 ? word : word.slice(0, equal)
      if (option !== '--pid' && option !== '--format') throw new Error('unknown gnu long option')
      const value = equal < 0 ? (words[at++] ?? '') : word.slice(equal + 1)
      if (option === '--pid') for (const pid of psPids(value, option)) pids.add(pid)
      else columns.push(...psColumns(value, option))
      continue
    }
    if (!word.startsWith('-')) {
      if (!/^[auxwf]+$/.test(word)) throw new Error('unsupported option (BSD syntax)')
      all ||= /[ax]/.test(word)
      continue
    }
    let letters = word.slice(1)
    while (letters !== '') {
      const flag = letters.charAt(0)
      letters = letters.slice(1)
      if (PS_ALL.has(flag)) {
        all = true
        continue
      }
      if (flag === 'f') continue
      if (flag !== 'p' && flag !== 'o') throw new Error('unsupported SysV option')
      const value = letters !== '' ? letters : (words[at++] ?? '')
      letters = ''
      if (flag === 'p') for (const pid of psPids(value, '-p')) pids.add(pid)
      else columns.push(...psColumns(value, '-o'))
    }
  }
  return { pids, all, columns }
}

/** One row in procps's layout: each column padded but the last. */
function psRow(keys: readonly string[], cells: readonly string[]): string {
  return keys
    .map((key, at) => {
      const [, width, right] = PS_COLUMNS[key] ?? ['', 0, false, '']
      const cell = cells[at] ?? ''
      if (right) return cell.padStart(width)
      return at === keys.length - 1 ? cell : cell.padEnd(width)
    })
    .join(' ')
}

/**
 * What every row of one ps line reads besides its runner: the moment ps runs
 * (epoch seconds), the zone times print in (the session's TZ), the workspace
 * user who owns every runner, the session's profile as their group, and the
 * calling session with its `$$`.
 */
interface PsContext {
  now: number
  zone: Zone
  user: string | null
  group: string | null
  sessionId: string
  shellPid: number | null
}

/** procps's etime: `[[DD-]hh:]mm:ss`. */
function elapsed(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  const two = (n: number): string => String(n).padStart(2, '0')
  if (days > 0) return `${String(days)}-${two(hours)}:${two(minutes)}:${two(secs)}`
  if (hours > 0) return `${two(hours)}:${two(minutes)}:${two(secs)}`
  return `${two(minutes)}:${two(secs)}`
}

/**
 * One start-time column, procps's pr_lstart, pr_start, pr_stime or
 * pr_bsdstart: a day-old start prints its date, a recent one its clock.
 */
function started(fact: string, info: ProcessInfo, ctx: PsContext): string {
  const start = new Date(info.startedAt * 1000)
  if (fact === 'lstart') return gnuStrftime(start, '%a %b %e %H:%M:%S %Y', ctx.zone)
  const old = ctx.now - info.startedAt > 86400
  if (fact === 'start') return gnuStrftime(start, old ? '  %b %d' : '%H:%M:%S', ctx.zone)
  if (fact === 'bsdstart') return gnuStrftime(start, old ? '%b %e' : '%H:%M', ctx.zone)
  const now = ctx.zone.parts(new Date(ctx.now * 1000))
  const then = ctx.zone.parts(start)
  if (now.year !== then.year) return gnuStrftime(start, '%Y', ctx.zone)
  if (now.month !== then.month || now.day !== then.day) {
    return gnuStrftime(start, '%b%d', ctx.zone)
  }
  return gnuStrftime(start, '%H:%M', ctx.zone)
}

/**
 * One -o cell for a managed runner. The owner columns print the workspace user
 * and the session's profile, names in the id columns too, as `id` does, and
 * `-` where nobody claimed one or the runner is another session's, whose
 * profile this one cannot name. A runner of the calling session belongs to the
 * session `$$` leads; another session's to its own group.
 */
function psCell(key: string, info: ProcessInfo, ctx: PsContext): string {
  const fact = PS_COLUMNS[key]?.[3] ?? ''
  const fixed = PS_FIXED[fact]
  if (fixed !== undefined) return fixed
  const session =
    info.sessionId === ctx.sessionId && ctx.shellPid !== null
      ? ctx.shellPid
      : info.groupId || info.pid
  if (fact === 'pid') return String(info.pid)
  if (fact === 'ppid') return String(info.parentPid ?? 0)
  if (fact === 'pgid') return String(info.groupId || info.pid)
  if (fact === 'sid') return String(session)
  if (fact === 'stat' || fact === 'state') {
    return PS_STATES[info.state] + (fact === 'stat' && info.pid === session ? 's' : '')
  }
  if (fact === 'comm') {
    const head = info.command.split(/\s+/).find((w) => w !== '') ?? ''
    return (head.split('/').pop() ?? '').slice(0, 15)
  }
  if (fact === 'user') return ctx.user ?? UNKNOWN_NAME
  if (fact === 'group') return (info.sessionId === ctx.sessionId ? ctx.group : null) ?? UNKNOWN_NAME
  const age = Math.max(0, Math.floor(ctx.now - info.startedAt))
  if (fact === 'etime') return elapsed(age)
  if (fact === 'etimes') return String(age)
  if (['lstart', 'start', 'stime', 'bsdstart'].includes(fact)) return started(fact, info, ctx)
  return info.command
}

/**
 * List managed runners with procps's selection and `-o` columns. A runner
 * has no CPU, RSS or TTY accounting, so without `-o` the rows stay mirage's
 * compact `PID<TAB>COMMAND` and never broaden the profile's view. `-o` lays
 * out procps-ng 4.0.4's columns, every key a runner can answer (PS_COLUMNS);
 * a header row prints unless every header is empty. Selecting nothing (`-p`
 * of an absent PID) exits 1, as procps does, and an option error is
 * procps's message and usage.
 */
export function handlePs(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
  user: string | null = null,
): JobHandlerResult {
  const cmdStr = parts.join(' ')
  let options: PsOptions
  try {
    options = parsePs(parts.slice(1))
  } catch (err) {
    return jobResult(cmdStr, `error: ${(err as Error).message}\n${PS_USAGE}`, 1)
  }
  const processes = processView(jobTable, session)
    .list()
    .filter((info) => options.all || options.pids.size === 0 || options.pids.has(info.pid))
  let lines: string[]
  if (options.columns.length > 0) {
    const keys = options.columns.map(([key]) => key)
    const ctx: PsContext = {
      now: Date.now() / 1000,
      zone: (session !== null ? zoneFromEnv(session.env) : null) ?? LOCAL_ZONE,
      user,
      group: session?.profile ?? null,
      sessionId: sessionOf(session),
      shellPid: session?.shellPid ?? null,
    }
    lines = processes.map((info) =>
      psRow(
        keys,
        keys.map((key) => psCell(key, info, ctx)),
      ),
    )
    if (options.columns.some(([, header]) => header !== ''))
      lines.unshift(
        psRow(
          keys,
          options.columns.map(([, header]) => header),
        ),
      )
  } else {
    lines = processes.map((info) => `${String(info.pid)}\t${info.command}`)
  }
  const code = processes.length > 0 ? 0 : 1
  const out = encodeText(lines.length > 0 ? lines.join('\n') + '\n' : '')
  return [
    out,
    new IOResult({ exitCode: code }),
    new ExecutionNode({ command: cmdStr, exitCode: code }),
  ]
}
