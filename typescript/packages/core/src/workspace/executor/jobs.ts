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
import { CommandTimeoutError } from '../../commands/builtin/utils/limit.ts'
import type { CallStack } from '../../shell/call_stack.ts'
import { ExitSignal } from '../../shell/errors.ts'
import type { JobTable } from '../../shell/job_table.ts'
import { mergeSignals } from '../abort.ts'
import type { Session } from '../session/session.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { ExecutionNode } from '../types.ts'

export type ExecuteNodeFn = (
  node: TSNodeLike,
  session: Session,
  stdin: ByteSource | null,
  callStack: CallStack | null,
) => Promise<[ByteSource | null, IOResult, ExecutionNode]>

export type JobHandlerResult = [ByteSource | null, IOResult, ExecutionNode]

export async function handleBackground(
  executeNode: ExecuteNodeFn,
  left: TSNodeLike,
  right: TSNodeLike | null,
  session: Session,
  jobTable: JobTable | null,
  agentId: string | null,
  stdin: ByteSource | null = null,
  callStack: CallStack | null = null,
): Promise<JobHandlerResult> {
  const bgSession = session.fork()

  const abort = new AbortController()
  // `kill %n` aborts this controller; the signal rides the forked
  // session so the job's whole subtree (builtins, mounts, runtimes)
  // observes the kill, merged with any enclosing job's channel.
  bgSession.abortSignal = mergeSignals(session.abortSignal, abort.signal) ?? abort.signal
  const cmdStrInner = left.text
  const task: Promise<[ByteSource | null, IOResult, ExecutionNode]> = (async () => {
    let stdout: ByteSource | null
    let io: IOResult
    let execNode: ExecutionNode
    try {
      ;[stdout, io, execNode] = await executeNode(left, bgSession, null, callStack)
    } catch (err) {
      if (err instanceof CommandTimeoutError) {
        const msg = new TextEncoder().encode(`${err.message}\n`)
        return [
          new Uint8Array(),
          new IOResult({ exitCode: 124, stderr: msg }),
          new ExecutionNode({ command: cmdStrInner, stderr: msg, exitCode: 124 }),
        ]
      }
      if (err instanceof ExitSignal) {
        // A background job is its own shell: exit ends the job only.
        return [
          err.stdout ?? new Uint8Array(),
          new IOResult({ exitCode: err.containedCode, stderr: err.stderr }),
          new ExecutionNode({
            command: cmdStrInner,
            stderr: err.stderr,
            exitCode: err.containedCode,
          }),
        ]
      }
      throw err
    }
    const materialized = await materialize(stdout)
    io.syncExitCode()
    return [materialized, io, execNode]
  })()
  task.catch(() => {
    // unhandled rejections silenced here; callers use jobTable.wait()
  })

  const cmdStr = left.text
  // Non-interactive bash announces nothing on launch ("[1] <pid>" is
  // interactive-only); the job stays discoverable via $! and `jobs`.
  if (jobTable !== null) {
    const job = jobTable.submit({
      command: cmdStr,
      task,
      abort,
      cwd: bgSession.cwd,
      agent: agentId ?? '',
      sessionId: session.sessionId,
    })
    session.lastBgJobId = job.id
  }

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

export async function handleWait(jobTable: JobTable, parts: string[]): Promise<JobHandlerResult> {
  const cmdStr = parts.join(' ')
  if (parts.length <= 1) {
    await jobTable.waitAll()
    return [null, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
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
  const io = new IOResult({
    exitCode: job.exitCode,
    stderr: job.stderr.byteLength > 0 ? job.stderr : null,
  })
  return [job.stdout, io, new ExecutionNode({ command: cmdStr, exitCode: job.exitCode })]
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
  const stdout = new Uint8Array(header.byteLength + job.stdout.byteLength)
  stdout.set(header, 0)
  stdout.set(job.stdout, header.byteLength)
  const io = new IOResult({
    exitCode: job.exitCode,
    stderr: job.stderr.byteLength > 0 ? job.stderr : null,
  })
  return [stdout, io, new ExecutionNode({ command: cmdStr, exitCode: job.exitCode })]
}

export function handleKill(jobTable: JobTable, parts: string[]): JobHandlerResult {
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
  const killed = jobTable.kill(jobId)
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
