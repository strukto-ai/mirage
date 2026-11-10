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

import type { RedirectResult } from '../../../src/context/session_context.ts'
import { type JobHandle, JobTable } from '../../../src/execution/job/index.ts'
import { pendingRun } from './job_runners.ts'
import { decoded } from './machine_resources.ts'

export async function withJobs(...commands: string[]): Promise<[JobTable, JobHandle[]]> {
  const table = new JobTable()
  const jobs: JobHandle[] = []
  for (const command of commands) {
    const abort = new AbortController()
    jobs.push(await table.submit({ command, run: pendingRun(abort), abort, cwd: '/' }))
  }
  return [table, jobs]
}

export async function stop(table: JobTable, jobs: readonly JobHandle[]): Promise<void> {
  for (const job of jobs) await table.kill(job.id)
}

export function text(result: RedirectResult): [string, string, number] {
  const [out, io] = result
  return [decoded(out), decoded(io.stderr), io.exitCode]
}
