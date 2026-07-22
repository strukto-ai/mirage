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
import { IOResult, materialize } from '../../io/types.ts'
import { CommandTimeoutError } from '../../commands/builtin/utils/safeguard.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import type { Job, JobTable } from '../../shell/job_table.ts'
import { Channel, type JobConsole } from '../../shell/console/index.ts'
import type { Session } from '../session/session.ts'
import type { TSNodeLike } from '../expand/variable.ts'
import { ExecutionNode } from '../types.ts'

/** Per-call overrides a caller can layer onto the walker's deps. */
export interface ExecuteNodeOpts {
  sink?: JobConsole
  signal?: AbortSignal
}

export type ExecuteNodeFn = (
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
  opts?: ExecuteNodeOpts,
) => Promise<[ByteSource | null, IOResult, ExecutionNode]>

type JobHandlerResult = [ByteSource | null, IOResult, ExecutionNode]

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
): Promise<JobHandlerResult> {
  const bgSession = session.fork()

  const abort = new AbortController()
  const cmdStrInner = left.text
  const runBg = async (job: Job): Promise<[IOResult, ExecutionNode]> => {
    const console_ = job.console
    let stdout: ByteSource | null
    let io: IOResult
    let execNode: ExecutionNode
    try {
      // The sink is what makes compound bodies stream: each statement
      // writes as it finishes rather than the whole construct landing
      // at the end. The signal is what makes `kill` able to stop the
      // job at all, since a promise cannot be cancelled.
      ;[stdout, io, execNode] = await executeNode(left, bgSession, null, callStack, {
        sink: console_,
        signal: abort.signal,
      })
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
    await pump(console_, Channel.STDOUT, stdout)
    const stderr = await io.materializeStderr()
    if (stderr.byteLength > 0) {
      await console_.emit(Channel.STDERR, stderr)
    }
    io.syncExitCode()
    return [io, execNode]
  }

  const cmdStr = left.text
  const job = jobTable.submit({
    command: cmdStr,
    run: runBg,
    abort,
    cwd: bgSession.cwd,
    agent: agentId ?? '',
    sessionId: session.sessionId,
  })
  session.lastBgJobId = job.id
  const jobLine = new TextEncoder().encode(`[${job.id.toString()}]\n`)

  if (right === null) {
    const io = new IOResult({ stderr: jobLine })
    const tree = new ExecutionNode({
      op: '&',
      exitCode: 0,
      children: [new ExecutionNode({ command: cmdStr, exitCode: 0 })],
    })
    return [null, io, tree]
  }

  const [rightStdout, rightIo, rightExec] = await executeNode(right, session, stdin, callStack)
  const leftStderr = await materialize(rightIo.stderr)
  rightIo.stderr = leftStderr.byteLength > 0 ? concat([jobLine, leftStderr]) : jobLine
  const children = [new ExecutionNode({ command: cmdStr, exitCode: 0 }), rightExec]
  const tree = new ExecutionNode({
    op: '&',
    exitCode: rightIo.exitCode,
    children,
  })
  return [rightStdout, rightIo, tree]
}

export async function handleWait(jobTable: JobTable, parts: string[]): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
  if (parts.length <= 1) {
    // Bare `wait` adopts every job's output, the way `wait <id>` already
    // does for one. A real shell has nothing to adopt: its jobs share the
    // terminal and have printed already. Mirage jobs print to their
    // console, so the shell has to surface it or the output is stranded.
    //
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
  const raw = (parts[1] ?? '').replace(/^%+/, '')
  const jobId = Number(raw)
  if (!Number.isInteger(jobId)) {
    const err = new TextEncoder().encode(`wait: invalid job id: ${parts[1] ?? ''}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  const existing = jobTable.get(jobId)
  if (existing === null) {
    const err = new TextEncoder().encode(`wait: no such job: ${jobId.toString()}\n`)
    return [
      null,
      new IOResult({ exitCode: 1, stderr: err }),
      new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
    ]
  }
  const job = await jobTable.wait(jobId)
  const stdout = await job.console.snapshot(Channel.STDOUT)
  const stderr = await job.console.snapshot(Channel.STDERR)
  const io = new IOResult({
    exitCode: job.exitCode,
    stderr: stderr.byteLength > 0 ? stderr : null,
  })
  return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: job.exitCode })]
}

/**
 * Foreground a background job: print its command line, then block on it
 * and adopt its output and exit code.
 */
export async function handleFg(jobTable: JobTable, parts: string[]): Promise<JobHandlerResult> {
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
  const stdout = new Uint8Array(header.byteLength + body.byteLength)
  stdout.set(header, 0)
  stdout.set(body, header.byteLength)
  const io = new IOResult({
    exitCode: job.exitCode,
    stderr: stderr.byteLength > 0 ? stderr : null,
  })
  return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: job.exitCode })]
}

export async function handleKill(jobTable: JobTable, parts: string[]): Promise<JobHandlerResult> {
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

export function handleJobs(jobTable: JobTable, parts: string[]): JobHandlerResult {
  const cmdStr = parts.join(' ')
  const lines: string[] = []
  for (const job of jobTable.listJobs()) {
    lines.push(`[${job.id.toString()}] ${job.status} ${job.command}`)
  }
  jobTable.popCompleted()
  const out =
    lines.length > 0 ? new TextEncoder().encode(`${lines.join('\n')}\n`) : new Uint8Array()
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}

export function handlePs(jobTable: JobTable, parts: string[]): JobHandlerResult {
  const cmdStr = parts.join(' ')
  const lines: string[] = []
  for (const job of jobTable.runningJobs()) {
    lines.push(`${job.id.toString()}\t${job.command}`)
  }
  const out =
    lines.length > 0 ? new TextEncoder().encode(`${lines.join('\n')}\n`) : new Uint8Array()
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
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
