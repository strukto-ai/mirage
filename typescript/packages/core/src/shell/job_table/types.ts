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

import type { ProcessHandle } from '../../process/handle.ts'
import type { IOResult } from '../../io/types.ts'
import type { ExecutionNode } from '../../workspace/types.ts'
import { JobConsole } from '../console/index.ts'

export const JobStatus = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  KILLED: 'killed',
} as const)

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus]

export type JobResult = [IOResult, ExecutionNode]

/** Produces a job's output and its result. */
export type JobRunner = (job: Job) => Promise<JobResult>

/** Builds each new job's console from its job id. */
export type ConsoleFactory = (jobId: number) => JobConsole

/**
 * One background command, and everything it has printed.
 *
 * Output lives in `console` rather than in byte fields, so a reader can
 * watch a job while it runs instead of waiting for it to end. A `simple`
 * job is one simple command, which the job is, so a program it ran that
 * handled a `kill` leaves the job its own status.
 */
export class Job {
  readonly id: number
  readonly command: string
  // null for jobs restored from a snapshot (already finished, no runner).
  process: ProcessHandle | null = null
  readonly abort: AbortController | null
  readonly cwd: string
  readonly sessionId: string
  readonly createdAt: number
  readonly console: JobConsole
  readonly simple: boolean

  status: JobStatus = JobStatus.RUNNING
  exitCode = 0

  constructor(init: {
    id: number
    command: string
    abort?: AbortController | null
    cwd: string
    sessionId?: string
    createdAt: number
    status?: JobStatus
    exitCode?: number
    console?: JobConsole
    simple?: boolean
  }) {
    this.id = init.id
    this.command = init.command
    this.abort = init.abort ?? null
    this.cwd = init.cwd
    this.sessionId = init.sessionId ?? ''
    this.createdAt = init.createdAt
    this.console = init.console ?? new JobConsole()
    this.simple = init.simple ?? false
    if (init.status !== undefined) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
  }

  /**
   * The managed PID `$!`, `jobs -p` and `wait -p` report. A job restored
   * from a snapshot has no runner, so its job number stands in.
   */
  get pid(): number {
    return this.process?.info.pid ?? this.id
  }

  get executionId(): string | null {
    return this.process?.info.executionId ?? this.console.executionId
  }
}
