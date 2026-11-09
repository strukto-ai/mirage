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
import { processStatus } from '../../../../shell/signals.ts'
import type { JobHandle, JobTable } from '../../../../execution/job/index.ts'
import { shownPid } from '../../../../execution/process/types.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { builtinUsage } from '../shared.ts'
import * as constants from './constants.ts'
import { AMBIGUOUS_SPEC, jobOfSpec, sessionOf } from '../jobspec.ts'

/** How bash's `jobs` words where a job stands. */
function jobStatus(job: JobHandle): string {
  return job.state === 'running'
    ? 'Running'
    : processStatus(job.exitCode, job.signal ?? job.process?.endedBy ?? null)
}

/**
 * One `jobs` line, in bash's layout; `-l` includes its pid. `mark` is `+` for
 * the newest job, `-` for the one before it, else a space.
 */
function jobRow(job: JobHandle, long: boolean, mark: string): string {
  const id = job.id.toString()
  const status = jobStatus(job).padEnd(24)
  const running = job.state === 'running' ? ' &' : ''
  const stages = job.process?.stages ?? []
  const [first, ...rest] = stages.map((stage) => stage.record)
  if (long && first !== undefined) {
    const lead = `[${id}]${mark} ${String(shownPid(first)).padStart(5)} ${status}${first.command}`
    const more = rest.map(
      (r) => `${' '.repeat(5)}${String(shownPid(r)).padStart(5)} ${' '.repeat(22)}| ${r.command}`,
    )
    return [lead, ...more].join('\n') + running
  }
  const command = job.command + running
  return long
    ? `[${id}]${mark} ${String(job.shownPid).padStart(5)} ${status}${command}`
    : `[${id}]${mark}  ${status}${command}`
}

/**
 * List jobs as bash does, the machines looked at first.
 *
 * `-p` prints the PID; `-s` lists nothing because a non-interactive shell
 * reports no job as stopped. `-r` keeps running jobs, `-l` adds the PID, and
 * `-n` lists only the jobs whose status changed since the last `jobs`
 * (which is every completed one not yet reaped, since reaping is what a
 * listing does). A jobspec operand (`%2` or `2`) filters to that job;
 * one that names no job is `no such job`, exit 1. `-x` is not carried,
 * and an unknown letter is GNU's usage line, exit 2.
 */
export async function handleJobs(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  const flags = new Set<string>()
  const specs: string[] = []
  for (const word of parts.slice(1)) {
    if (word.startsWith('-') && word.length > 1 && specs.length === 0) {
      if (word === '--') continue
      const bad = Array.from(word.slice(1)).find((c) => !constants.FLAGS.has(c))
      if (bad !== undefined) {
        const err = encodeText(
          `${shellVoice()}jobs: -${bad}: invalid option\n${builtinUsage('jobs')}`,
        )
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
  for (let table: JobTable | null = jobTable; table !== null; table = table.parent)
    await table.sync(sid)
  await jobTable.processes.scan()
  let jobs = jobTable.listing(sid).filter((j) => !j.reported)
  const [current, previous] = jobTable.jobMarks(sid)
  const marks = new Map([
    [current, '+'],
    [previous, '-'],
  ])
  if (specs.length > 0) {
    const picked: JobHandle[] = []
    for (const spec of specs) {
      const [job, refusal] = jobOfSpec(jobs, spec.startsWith('%') ? spec : `%${spec}`)
      if (job === null) {
        const said = `${shellVoice()}jobs: ${spec}: no such job\n`
        const err = encodeText(
          refusal.endsWith(AMBIGUOUS_SPEC) ? `${shellVoice()}jobs: ${refusal}\n${said}` : said,
        )
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
  if (flags.has('r')) jobs = jobs.filter((j) => j.state === 'running')
  if (flags.has('s')) jobs = []
  if (flags.has('n')) jobs = jobs.filter((j) => !j.listed || j.state !== 'running')
  const lines = flags.has('p')
    ? jobs.map((j) => String(j.shownPid))
    : jobs.map((j) => {
        j.listed = true
        return jobRow(j, flags.has('l'), marks.get(j.id) ?? ' ')
      })
  await jobTable.popCompleted(sid)
  const out = lines.length > 0 ? encodeText(`${lines.join('\n')}\n`) : new Uint8Array()
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}
