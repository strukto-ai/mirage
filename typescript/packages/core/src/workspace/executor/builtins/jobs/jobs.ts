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
import { builtinUsage } from '../shared.ts'
import { JOBS_FLAGS } from './constants.ts'
import { jobNumbered, sessionOf } from '../jobspec.ts'

/** One `jobs` line; `-l` includes the managed PID. */
function jobRow(job: JobHandle, long: boolean): string {
  const id = job.id.toString()
  const status = job.state === 'running' ? 'running' : job.signal !== null ? 'killed' : 'completed'
  return long
    ? `[${id}] ${String(job.pid)} ${status} ${job.command}`
    : `[${id}] ${status} ${job.command}`
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
      const bad = Array.from(word.slice(1)).find((c) => !JOBS_FLAGS.has(c))
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
  let jobs = jobTable.listing(sid).filter((j) => !j.reported)
  if (specs.length > 0) {
    const picked: JobHandle[] = []
    for (const spec of specs) {
      const raw = spec.replace(/^%+/, '')
      const job = /^\d+$/.test(raw) ? jobNumbered(jobs, Number(raw)) : null
      if (job === null) {
        const err = encodeText(`${shellVoice()}jobs: ${spec}: no such job\n`)
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
  if (flags.has('n')) jobs = jobs.filter((j) => j.state !== 'running')
  const lines = flags.has('p')
    ? jobs.map((j) => String(j.pid))
    : jobs.map((j) => jobRow(j, flags.has('l')))
  await jobTable.popCompleted(sid)
  const out = lines.length > 0 ? encodeText(`${lines.join('\n')}\n`) : new Uint8Array()
  return [out, new IOResult(), new ExecutionNode({ command: cmdStr, exitCode: 0 })]
}
