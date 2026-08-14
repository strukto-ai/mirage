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
 * watch a job while it runs instead of waiting for it to end.
 */
export class Job {
  readonly id: number
  readonly command: string
  // null for jobs restored from a snapshot (already finished, no live task).
  task: Promise<void> | null
  readonly abort: AbortController | null
  readonly cwd: string
  readonly agent: string
  readonly sessionId: string
  readonly createdAt: number
  readonly console: JobConsole

  status: JobStatus = JobStatus.RUNNING
  exitCode = 0
  executionNode: ExecutionNode | null = null
  ioResult: IOResult | null = null

  constructor(init: {
    id: number
    command: string
    task?: Promise<void> | null
    abort?: AbortController | null
    cwd: string
    agent?: string
    sessionId?: string
    createdAt?: number
    status?: JobStatus
    exitCode?: number
    console?: JobConsole
  }) {
    this.id = init.id
    this.command = init.command
    this.task = init.task ?? null
    this.abort = init.abort ?? null
    this.cwd = init.cwd
    this.agent = init.agent ?? 'unknown'
    this.sessionId = init.sessionId ?? ''
    this.createdAt = init.createdAt ?? Date.now() / 1000
    this.console = init.console ?? new JobConsole()
    if (init.status !== undefined) this.status = init.status
    if (init.exitCode !== undefined) this.exitCode = init.exitCode
  }
}
