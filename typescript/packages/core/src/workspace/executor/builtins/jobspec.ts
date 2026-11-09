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

import type { RedirectResult } from '../../../context/session_context.ts'
import { IOResult } from '../../../io/types.ts'
import type { ProcessHandle } from '../../../execution/process/handle.ts'
import { shownMachine, shownPid, type Process } from '../../../execution/process/types.ts'
import { RUN_WATCH_SECONDS } from '../../../machine/constants.ts'
import { settledWithin } from '../../../utils/abort.ts'
import {
  DEFAULT_PROCESS_PERMISSIONS,
  type ProcessPermissions,
} from '../../../execution/process/config.ts'
import type { ProcessTable } from '../../../execution/process/table.ts'
import { encodeText } from '../../../shell/bytes.ts'
import type { JobHandle } from '../../../execution/job/index.ts'
import type { SessionState } from '../../session/session.ts'
import { ExecutionNode } from '../../types.ts'

/** A job builtin's refusal: nothing on stdout, `msg` on stderr. */
export function jobResult(cmdStr: string, msg: string, code: number): RedirectResult {
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
export function sessionOf(session: SessionState | null): string {
  return session?.sessionId ?? ''
}

/** What `ps` and numeric `kill` may reach, by the session's profile. */
export function grantsOf(session: SessionState | null): ProcessPermissions {
  return session?.processes ?? DEFAULT_PROCESS_PERMISSIONS
}

/**
 * The job whose number is `jobId`, the one `%N` names: none once its report
 * was printed, as bash then drops it from its list.
 */
/**
 * Wait for `waiting`, looking at the machines every `RUN_WATCH_SECONDS`
 * meanwhile, so a run whose exec stays open ends when its program does.
 * Mirrors Python's `scanning_while`.
 */
export async function scanningWhile<T>(processes: ProcessTable, waiting: Promise<T>): Promise<T> {
  while (!(await settledWithin(waiting, RUN_WATCH_SECONDS))) await processes.scan()
  return waiting
}

/**
 * Whether `-m` picks a process: `name` as `ps` shows its machine, or without
 * the provider; null for no `-m`. Mirrors Python's `on_machine`.
 */
export function onMachine(process: Process, name: string | null): boolean {
  const shown = shownMachine(process)
  return name === null || name === shown || name === shown.slice(shown.lastIndexOf(':') + 1)
}

/**
 * The process a machine pid names: a number under `FIRST_PID`, which kill,
 * wait and ps read as the pid of a program on its machine. The view is
 * brought in step with the machines first (`scan`). Answers the one process
 * the view sees whose program has that pid on its machine, null for none,
 * and whether processes on more than one machine have it, which bash's
 * `ambiguous job spec` refuses. Mirrors Python's `machine_process`.
 *
 * @param processes the session's view of the processes.
 * @param number the pid as typed.
 * @param machine only that machine's (`onMachine`).
 */
export async function machineProcess(
  processes: ProcessTable,
  session: SessionState | null,
  number: number,
  machine: string | null = null,
): Promise<[Process | null, boolean]> {
  await processes.scan()
  const found = processes
    .visible(sessionOf(session), grantsOf(session))
    .filter(
      (process) =>
        process.machinePid !== null &&
        process.machinePid.pid === number &&
        process.machinePid.exited == null &&
        onMachine(process, machine),
    )
  const machines = new Set(found.map((process) => process.machine.toString()))
  if (machines.size > 1) return [null, true]
  return [found[0] ?? null, false]
}

/**
 * The job whose own process ran the program a machine pid names, which
 * `wait` reads as the pid of a program on its machine. A job whose program
 * has ended still answers until the job is collected. The view is brought
 * in step with the machines first (`scan`), which learns a program's pid
 * there. Returns the job, a running program's before an ended one's, null
 * for none, and whether jobs on more than one machine ran a program with
 * that pid, which bash's `ambiguous job spec` refuses.
 */
export async function jobWithMachinePid(
  processes: ProcessTable,
  jobs: readonly JobHandle[],
  number: number,
  machine: string | null = null,
): Promise<[JobHandle | null, boolean]> {
  await processes.scan()
  const held: [JobHandle, boolean][] = []
  const machines = new Set<string>()
  for (const job of jobs) {
    const record = job.process?.record
    if (record === undefined || record.machinePid?.pid !== number) continue
    if (!onMachine(record, machine)) continue
    held.push([job, record.machinePid.exited != null])
    machines.add(record.machine.toString())
  }
  if (machines.size > 1) return [null, true]
  held.sort((a, b) => Number(a[1]) - Number(b[1]))
  return [held[0]?.[0] ?? null, false]
}

export function jobNumbered(jobs: readonly JobHandle[], jobId: number): JobHandle | null {
  return jobs.find((j) => j.id === jobId && !j.reported) ?? null
}

/** The stage of a background pipeline a pid names, as `ps` shows it, and its job. */
export function stageWithPid(
  jobs: readonly JobHandle[],
  pid: number,
): [JobHandle, ProcessHandle] | null {
  for (const job of jobs)
    for (const stage of job.process?.stages ?? [])
      if (shownPid(stage.record) === pid) return [job, stage]
  return null
}

export const AMBIGUOUS_SPEC = 'ambiguous job spec'

/**
 * The job a `%` spec names, or bash's refusal: `%N`; `%%`, `%+` or a bare `%`
 * for the newest, `%-` for the one before it; `%name` for the job whose
 * command starts with `name` and `%?text` for the one whose command holds
 * `text`. Mirrors Python's `job_of_spec`.
 */
export function jobOfSpec(jobs: readonly JobHandle[], spec: string): [JobHandle | null, string] {
  const body = spec.slice(1)
  const missing = `${spec}: no such job`
  if (/^[0-9]+$/.test(body)) {
    const numbered = jobNumbered(jobs, Number(body))
    return [numbered, numbered !== null ? '' : missing]
  }
  const listed = jobs.filter((job) => !job.reported).sort((a, b) => b.id - a.id)
  if (body === '' || body === '%' || body === '+' || body === '-') {
    const job = listed[body === '-' && listed.length > 1 ? 1 : 0]
    return job === undefined ? [null, missing] : [job, '']
  }
  const anywhere = body.startsWith('?')
  const text = anywhere ? body.slice(1) : body
  const named = listed.filter((job) =>
    anywhere ? job.command.includes(text) : job.command.startsWith(text),
  )
  if (named.length > 1) return [null, `${text}: ${AMBIGUOUS_SPEC}`]
  const [job] = named
  return job === undefined ? [null, missing] : [job, '']
}

/**
 * The job a bare PID names. A job whose runner is here answers by its
 * runner's PID. One with no runner here, restored or another workspace's,
 * answers by the job number standing in for one, but only where no runner
 * here holds that PID: another workspace numbers its jobs on the shared
 * list, so its `%2` can share a number with a PID handed out here.
 */
export function jobWithPid(jobs: readonly JobHandle[], pid: number): JobHandle | null {
  return (
    jobs.find(
      (j) =>
        j.process !== null && (j.pid === pid || j.process.record.stages?.includes(pid) === true),
    ) ??
    jobs.find((j) => j.process === null && j.pid === pid) ??
    null
  )
}

/**
 * The job a `wait`/`disown` operand names, or bash's refusal. A `%N`
 * spec naming no job is `no such job`; a bare number is a managed PID,
 * also returned by `$!`, so an unknown one is `pid N is not a child of
 * this shell`. Anything else is `not a pid or valid job spec`.
 */
export function resolveSpec(jobs: readonly JobHandle[], spec: string): [JobHandle | null, string] {
  if (spec.startsWith('%')) return jobOfSpec(jobs, spec)
  if (/^[0-9]+$/.test(spec)) {
    const job = jobWithPid(jobs, Number(spec))
    return [job, job !== null ? '' : `pid ${spec} is not a child of this shell`]
  }
  return [null, `\`${spec}': not a pid or valid job spec`]
}
