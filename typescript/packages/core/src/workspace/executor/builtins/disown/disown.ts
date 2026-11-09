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

import { shellVoice } from '../../../../shell/voice.ts'
import type { RedirectResult } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import type { JobHandle, JobTable } from '../../../../execution/job/index.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { scanOptions } from '../getopt.ts'
import { builtinUsage } from '../shared.ts'
import { AMBIGUOUS_SPEC, jobOfOperand, jobOfSpec, jobResult, sessionOf } from '../jobspec.ts'

/**
 * Drop jobs from the table without stopping them. No operand means the
 * current job (the newest), `-a` every job, `-r` the running ones, and
 * `%N`/`N` specs name jobs; `-h` marks a job to survive SIGHUP and leaves
 * it in the table, a no-op here since no hangup is ever delivered. A spec
 * naming no job is `no such job`, exit 1, and the others still drop.
 */
export async function handleDisown(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  const scan = scanOptions(parts.slice(1), 'arh')
  if (scan.bad !== null) {
    return jobResult(
      cmdStr,
      `${shellVoice()}disown: ${scan.bad}: invalid option\n${builtinUsage('disown')}`,
      2,
    )
  }
  const allJobs = scan.letters.includes('a')
  const runningOnly = scan.letters.includes('r')
  const keep = scan.letters.includes('h')
  const specs = scan.operands
  let targets: JobHandle[] = []
  const errors: string[] = []
  await jobTable.sync(sid)
  const jobs = jobTable.listJobs(sid)
  const marks = jobTable.jobMarks(sid)
  if (specs.length > 0) {
    for (const spec of specs) {
      const [job, refusal] = await jobOfOperand(jobTable.processes, jobs, spec, marks)
      if (job === null) {
        const said = refusal.endsWith(AMBIGUOUS_SPEC) ? refusal : `${spec}: no such job`
        errors.push(`${shellVoice()}disown: ${said}`)
        continue
      }
      targets.push(job)
    }
  } else if (allJobs || runningOnly) {
    targets = runningOnly ? jobs.filter((j) => j.state === 'running') : jobs
  } else {
    const [current] = jobOfSpec(jobs, '%%', marks)
    if (current === null) {
      return jobResult(cmdStr, `${shellVoice()}disown: current: no such job\n`, 1)
    }
    targets = [current]
  }
  if (!keep) {
    for (const job of targets) await jobTable.disown(job.id, sid)
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
