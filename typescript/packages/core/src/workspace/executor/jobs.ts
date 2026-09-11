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

import type { ByteSource } from '../../io/types.ts'
import { IOResult } from '../../io/types.ts'
import { concat } from '../../io/cachable_iterator.ts'
import { CommandTimeoutError } from '../../commands/errors.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import { type Job, JobStatus, type JobTable } from '../../shell/job_table/index.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import { runWithSession } from '../../context/session_context.ts'
import { asyncContextIsolatesTasks } from '../../utils/async_context.ts'
import { mergeSignals } from '../abort.ts'
import type { SessionView } from '../../ops/types.ts'
import type { Decisions } from '../../policy/decisions.ts'
import type { HandOff } from '../../policy/types.ts'
import type { Session } from '../session/session.ts'
import { occurrenceOf } from '../node/occurrence.ts'
import { scanOptions } from './builtins/getopt.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { ExecutionNode } from '../types.ts'

/** Per-call overrides a caller can layer onto the walker's deps. */
export interface ExecuteNodeOpts {
  sink?: JobConsole
  signal?: AbortSignal
  /** The hand-off the subtree runs on: a background job's own. */
  handed?: HandOff
}

export type ExecuteNodeFn = (
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
) => Promise<[ByteSource | null, IOResult, ExecutionNode]>

export type JobHandlerResult = [ByteSource | null, IOResult, ExecutionNode]

/**
 * Send a command's output to a console as chunks arrive.
 *
 * Consuming the stream piece by piece rather than materializing it whole
 * is what lets a reader watch a running job. A command that computes its
 * output eagerly still lands in one chunk, because there was nothing to
 * observe before it finished.
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
  }
}

export async function handleBackground(
  executeNode: ExecuteNodeFn,
  left: TSNodeLike,
  right: TSNodeLike | null,
  session: Session,
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
  const bgSession = session.fork()
  const jobHanded =
    handed !== null && decisions !== null
      ? decisions.split(session.sessionId, handed, occurrenceOf(left, handed))
      : null

  const abort = new AbortController()
  // `kill %n` aborts this controller; the signal rides the forked
  // session so the job's whole subtree (builtins, mounts, runtimes)
  // observes the kill, merged with any enclosing job's channel.
  bgSession.abortSignal = mergeSignals(session.abortSignal, abort.signal) ?? abort.signal
  const cmdStrInner = left.text
  const runBg = async (job: Job): Promise<[IOResult, ExecutionNode]> => {
    const console_ = job.console
    const body = async (): Promise<[IOResult, ExecutionNode]> => {
      let stdout: ByteSource | null
      let io: IOResult
      let execNode: ExecutionNode
      try {
        // The sink is what makes compound bodies stream: each statement
        // writes as it finishes rather than the whole construct landing
        // at the end. The signal is what makes `kill` able to stop the
        // job at all, since a promise cannot be cancelled.
        const opts: ExecuteNodeOpts = { sink: console_, signal: abort.signal }
        if (jobHanded !== null) opts.handed = jobHanded
        ;[stdout, io, execNode] = await executeNode(left, bgSession, null, callStack, opts)
      } catch (err) {
        if (err instanceof CommandTimeoutError) {
          const msg = new TextEncoder().encode(`${err.message}\n`)
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
    // The runner's task inherits the OUTER ambient session from its
    // creation context, and the fork keeps its parent's id, so without
    // this rebind a nested eval inside the job resolves the ambient
    // outer session and escapes the fork.
    //
    // A job runs concurrently with the rest of the line, so the bind is
    // only safe where the async context isolates tasks. On the fallback
    // storage (a browser with no AsyncLocalStorage) the fork's frame
    // would stay live beside the foreground's under the same owner and
    // manager, with nothing to say whose read is whose: newest-wins
    // reads would hand the fork to the rest of the line, and the
    // restrictive folds would hold the line to the fork's view. There
    // the job's inner evals resolve by id instead, which is what they
    // did before ambient sessions existed: a job that leaks into its
    // own nested eval is narrower than a job that leaks into the whole
    // line.
    try {
      return await (asyncContextIsolatesTasks ? runWithSession(bgSession, body) : body())
    } finally {
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
    })
  } catch (err) {
    // A submission that fails (a console the table cannot build) starts
    // no runner, so nothing would ever revoke the job's hand-off: its
    // grants would stay reserved for good, neither spent nor on offer
    // to any later line.
    if (jobHanded !== null && decisions !== null) {
      await decisions.revoke(session.sessionId, jobHanded)
    }
    throw err
  }
  session.lastBgJobId = job.id

  if (right === null) {
    const tree = new ExecutionNode({
      op: '&',
      exitCode: 0,
      children: [new ExecutionNode({ command: cmdStr, exitCode: 0 })],
    })
    return [null, new IOResult(), tree]
  }

  const [rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
  const children = [new ExecutionNode({ command: cmdStr, exitCode: 0 }), rightExec]
  const tree = new ExecutionNode({
    op: '&',
    exitCode: rightIo.exitCode,
    children,
  })
  return [rightStdout, rightIo, tree]
}

const WAIT_USAGE = 'wait: usage: wait [-fn] [-p var] [id ...]'
const DISOWN_USAGE = 'disown: usage: disown [-h] [-ar] [jobspec ... | pid ...]'
const JOB_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function jobResult(cmdStr: string, msg: string, code: number): JobHandlerResult {
  const err = new TextEncoder().encode(msg)
  return [
    null,
    new IOResult({ exitCode: code, stderr: err }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err }),
  ]
}

/**
 * The job a `wait`/`disown` operand names, or bash's refusal. A `%N`
 * spec naming no job is `no such job`; a bare number is a pid in bash,
 * and mirage's `$!` yields the job id, so an unknown one is bash's `pid
 * N is not a child of this shell`. Anything else is `not a pid or valid
 * job spec`.
 */
function resolveSpec(jobTable: JobTable, spec: string): [Job | null, string] {
  if (spec.startsWith('%')) {
    const raw = spec.slice(1)
    const job = /^[0-9]+$/.test(raw) ? jobTable.get(Number(raw)) : null
    return [job, job !== null ? '' : `${spec}: no such job`]
  }
  if (/^[0-9]+$/.test(spec)) {
    const job = jobTable.get(Number(spec))
    return [job, job !== null ? '' : `pid ${spec} is not a child of this shell`]
  }
  return [null, `\`${spec}': not a pid or valid job spec`]
}

/** Block until the first of several jobs ends, and return it. */
async function waitFirst(jobTable: JobTable, jobs: Job[]): Promise<Job> {
  for (const job of jobs) {
    if (job.status !== JobStatus.RUNNING) return await jobTable.wait(job.id)
  }
  const races = jobs.map(async (job) => await jobTable.wait(job.id))
  return await Promise.race(races)
}

/** Report one finished job's output and status, and reap it. */
async function adopt(jobTable: JobTable, job: Job, cmdStr: string): Promise<JobHandlerResult> {
  const stdout = await job.console.snapshot(Channel.STDOUT)
  const stderr = await job.console.snapshot(Channel.STDERR)
  // Reaped like GNU bash reaps a job waited on by id, so a later bare
  // `wait` does not adopt this console a second time.
  jobTable.reap(job.id)
  const io = new IOResult({
    exitCode: job.exitCode,
    stderr: stderr.byteLength > 0 ? stderr : null,
  })
  return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: job.exitCode })]
}

/**
 * Wait for background jobs, with bash's option surface. Bare `wait`
 * joins every job and adopts each one's output in id order (a real shell
 * has nothing to adopt; mirage jobs print to their console, so the shell
 * has to surface it or it is stranded); `wait ID...` joins those and
 * answers the last one's status; `-n` joins the first of the given jobs
 * (or of all) to finish, 127 when there is nothing to wait for; `-p VAR`
 * stores the id of the job whose status is answered, unsetting VAR when
 * none is (which is the bare form, since it reports no one job); `-f` is
 * accepted, since a mirage job cannot stop, only end.
 *
 * Deliberate divergence: bash stores a PID in `-p`'s variable. A mirage
 * job is a coroutine with no OS process, so what goes there is the job
 * id, the same number `%N` and `jobs` already name.
 */
export async function handleWait(
  jobTable: JobTable,
  parts: string[],
  _session: Session | null = null,
  view: SessionView | null = null,
): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
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
  for (const spec of specs) {
    const [job, refusal] = resolveSpec(jobTable, spec)
    if (job === null) {
      errors.push(`bash: wait: ${refusal}`)
      continue
    }
    picked.push(job)
  }
  const errText = errors.length > 0 ? errors.join('\n') + '\n' : ''
  const errBytes = errText !== '' ? new TextEncoder().encode(errText) : null
  if (nextJob) {
    const candidates = specs.length > 0 ? picked : jobTable.listJobs()
    if (candidates.length === 0) {
      return [
        null,
        new IOResult({ exitCode: 127, stderr: errBytes }),
        new ExecutionNode({ command: cmdStr, exitCode: 127 }),
      ]
    }
    const job = await waitFirst(jobTable, candidates)
    if (varName !== null && view !== null) await view.set(varName, String(job.id))
    const [stdout, io, node] = await adopt(jobTable, job, cmdStr)
    if (errBytes !== null) {
      const prior = io.stderr instanceof Uint8Array ? io.stderr : new Uint8Array()
      io.stderr = concat([errBytes, prior])
    }
    return [stdout, io, node]
  }
  if (specs.length === 0) {
    // Every unreaped job, not just the ones still running: a job that
    // finished before this line was reached has output nobody has read,
    // and whether it finished in time is a scheduling accident. Ordered
    // by job id, because jobs finish concurrently and completion order
    // is not reproducible. Reaped afterwards so a second `wait` does not
    // print the same output twice.
    await jobTable.waitAll()
    const finished = jobTable.listJobs().sort((a, b) => a.id - b.id)
    const outs: Uint8Array[] = []
    const errs: Uint8Array[] = []
    for (const job of finished) {
      outs.push(await job.console.snapshot(Channel.STDOUT))
      errs.push(await job.console.snapshot(Channel.STDERR))
    }
    jobTable.popCompleted()
    const out = concat(outs)
    const err = concat(errs)
    return [
      out.byteLength > 0 ? out : null,
      new IOResult(err.byteLength > 0 ? { stderr: err } : {}),
      new ExecutionNode({ command: cmdStr, exitCode: 0 }),
    ]
  }
  if (picked.length === 0) {
    // Every spec was refused: bash answers 127 for a job it cannot find
    // and 1 for a word that is not a spec at all, the last one deciding.
    const last = errors[errors.length - 1] ?? ''
    const code = last.endsWith('not a pid or valid job spec') ? 1 : 127
    return jobResult(cmdStr, errText, code)
  }
  const outs: Uint8Array[] = []
  const errs: Uint8Array[] = errBytes !== null ? [errBytes] : []
  let lastCode = 0
  let lastJob: Job | null = null
  for (const job of picked) {
    const finished = await jobTable.wait(job.id)
    const [stdout, io] = await adopt(jobTable, finished, cmdStr)
    if (stdout instanceof Uint8Array && stdout.byteLength > 0) outs.push(stdout)
    if (io.stderr instanceof Uint8Array && io.stderr.byteLength > 0) errs.push(io.stderr)
    lastCode = io.exitCode
    lastJob = finished
  }
  // `wait id1 id2` answers with the last id's status, so `-p` names that
  // same job however many were waited for. Only the no-operand form
  // leaves the variable unset, since it reports no one job.
  if (varName !== null && view !== null && lastJob !== null) {
    await view.set(varName, String(lastJob.id))
  }
  const out = concat(outs)
  const err = concat(errs)
  return [
    out.byteLength > 0 ? out : null,
    new IOResult({ exitCode: lastCode, stderr: err.byteLength > 0 ? err : null }),
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
  _session: Session | null = null,
  _view: SessionView | null = null,
): JobHandlerResult {
  const cmdStr = parts.join(' ')
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
  if (specs.length > 0) {
    for (const spec of specs) {
      const [job] = resolveSpec(jobTable, spec)
      if (job === null) {
        errors.push(`bash: disown: ${spec}: no such job`)
        continue
      }
      targets.push(job)
    }
  } else if (allJobs || runningOnly) {
    targets = runningOnly ? jobTable.runningJobs() : jobTable.listJobs()
  } else {
    const jobs = jobTable.listJobs()
    const current = jobs[jobs.length - 1]
    if (current === undefined) {
      return jobResult(cmdStr, 'bash: disown: current: no such job\n', 1)
    }
    targets = [current]
  }
  if (!keep) {
    for (const job of targets) jobTable.disown(job.id)
  }
  const err = errors.length > 0 ? new TextEncoder().encode(errors.join('\n') + '\n') : null
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
 * and adopt its output and exit code.
 */
export async function handleFg(
  jobTable: JobTable,
  parts: string[],
  _session: Session | null = null,
  _view: SessionView | null = null,
): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
  let jobId: number
  if (parts.length <= 1) {
    const running = jobTable.runningJobs()
    const current = running[running.length - 1]
    if (current === undefined) {
      const err = new TextEncoder().encode('fg: current: no such job\n')
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
      ]
    }
    jobId = current.id
  } else {
    const raw = (parts[1] ?? '').replace(/^%+/, '')
    jobId = Number(raw)
    if (!Number.isInteger(jobId) || jobTable.get(jobId) === null) {
      const err = new TextEncoder().encode(`fg: ${parts[1] ?? ''}: no such job\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
      ]
    }
  }
  const job = await jobTable.wait(jobId)
  const header = new TextEncoder().encode(job.command + '\n')
  const body = await job.console.snapshot(Channel.STDOUT)
  const stderr = await job.console.snapshot(Channel.STDERR)
  jobTable.reap(jobId)
  const stdout = new Uint8Array(header.byteLength + body.byteLength)
  stdout.set(header, 0)
  stdout.set(body, header.byteLength)
  const io = new IOResult({
    exitCode: job.exitCode,
    stderr: stderr.byteLength > 0 ? stderr : null,
  })
  return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: job.exitCode })]
}

export async function handleKill(
  jobTable: JobTable,
  parts: string[],
  _session: Session | null = null,
  _view: SessionView | null = null,
): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
  if (parts.length < 2) {
    const err = new TextEncoder().encode('kill: usage: kill <job_id>\n')
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  const raw = (parts[1] ?? '').replace(/^%+/, '')
  const jobId = Number(raw)
  if (!Number.isInteger(jobId)) {
    const err = new TextEncoder().encode(`kill: invalid job id: ${parts[1] ?? ''}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  const killed = await jobTable.kill(jobId)
  if (!killed) {
    const err = new TextEncoder().encode(`kill: no such job: ${jobId.toString()}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  return [null, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}

const JOBS_FLAGS: ReadonlySet<string> = new Set('lnprs')
const JOBS_USAGE = 'jobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]'

/**
 * One `jobs` line in mirage's own row shape. `-l` inserts the id a
 * second time where GNU prints the process id; mirage jobs have no pid,
 * so the job id stands in and the row stays parseable.
 */
function jobRow(job: Job, long: boolean): string {
  const id = job.id.toString()
  return long
    ? `[${id}] ${id} ${job.status} ${job.command}`
    : `[${id}] ${job.status} ${job.command}`
}

/**
 * List jobs, with bash's flags applied to mirage's row shape.
 *
 * Mirage jobs are identified by table id, not pid, and never stop, so
 * two of GNU's flags map onto that model rather than reproducing it:
 * `-p` prints the job id (GNU's pid), and `-s` (stopped only) lists
 * nothing. `-r` keeps the running ones, `-l` adds the id column, and
 * `-n` lists only the jobs whose status changed since the last `jobs`
 * (which is every completed one not yet reaped, since reaping is what a
 * listing does). A jobspec operand (`%2` or `2`) filters to that job;
 * one that names no job is `no such job`, exit 1. `-x` is not carried,
 * and an unknown letter is GNU's usage line, exit 2.
 */
export function handleJobs(
  jobTable: JobTable,
  parts: string[],
  _session: Session | null = null,
  _view: SessionView | null = null,
): JobHandlerResult {
  const cmdStr = parts.join(' ')
  const flags = new Set<string>()
  const specs: string[] = []
  for (const word of parts.slice(1)) {
    if (word.startsWith('-') && word.length > 1 && specs.length === 0) {
      if (word === '--') continue
      const bad = Array.from(word.slice(1)).find((c) => !JOBS_FLAGS.has(c))
      if (bad !== undefined) {
        const err = new TextEncoder().encode(`bash: jobs: -${bad}: invalid option\n${JOBS_USAGE}\n`)
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
  let jobs = jobTable.listJobs()
  if (specs.length > 0) {
    const picked: Job[] = []
    for (const spec of specs) {
      const raw = spec.replace(/^%+/, '')
      const job = /^\d+$/.test(raw) ? jobTable.get(Number(raw)) : null
      if (job === null) {
        const err = new TextEncoder().encode(`bash: jobs: ${spec}: no such job\n`)
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
    ? jobs.map((j) => j.id.toString())
    : jobs.map((j) => jobRow(j, flags.has('l')))
  jobTable.popCompleted()
  const out =
    lines.length > 0 ? new TextEncoder().encode(`${lines.join('\n')}\n`) : new Uint8Array()
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}

export function handlePs(
  jobTable: JobTable,
  parts: string[],
  _session: Session | null = null,
  _view: SessionView | null = null,
): JobHandlerResult {
  const cmdStr = parts.join(' ')
  const lines: string[] = []
  for (const job of jobTable.runningJobs()) {
    lines.push(`${job.id.toString()}\t${job.command}`)
  }
  const out =
    lines.length > 0 ? new TextEncoder().encode(`${lines.join('\n')}\n`) : new Uint8Array()
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}
