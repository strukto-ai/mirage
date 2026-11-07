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
import type { JobConsole } from '../../../../shell/console/index.ts';
import { Channel } from '../../../../shell/console/index.ts'
import type { JobHandle, JobTable } from '../../../../execution/job/index.ts'
import { abortable } from '../../../../utils/abort.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { jobNumbered, sessionOf } from '../jobspec.ts'

/**
 * Foreground a background job: print its command line, then block on it
 * and answer its exit code. Its output goes where it always went, as it
 * is written, so the command line goes out first: to `sink`, where the
 * statement writes, before the job's next bytes. With no operand it takes
 * the newest running job, which is bash's current job; when none runs, it
 * takes the newest finished one, as `fg %N` would.
 */
export async function handleFg(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
  signal?: AbortSignal,
  sink?: JobConsole,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  await jobTable.sync(sid)
  const jobs = jobTable.listJobs(sid)
  let target: JobHandle
  if (parts.length <= 1) {
    const current = jobs.filter((j) => j.state === 'running').at(-1) ?? jobs.at(-1)
    if (current === undefined) {
      const err = encodeText(`${shellVoice()}fg: current: no such job\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
      ]
    }
    target = current
  } else {
    const raw = (parts[1] ?? '').replace(/^%+/, '')
    const jobId = Number(raw)
    const numbered = Number.isInteger(jobId) ? jobNumbered(jobs, jobId) : null
    if (numbered === null) {
      const err = encodeText(`${shellVoice()}fg: ${parts[1] ?? ''}: no such job\n`)
      return [
        null,
        new IOResult({ exitCode: 1, stderr: err }),
        new ExecutionNode({ command: cmdStr, exitCode: 1, stderr: err }),
      ]
    }
    target = numbered
  }
  const header = encodeText(target.command + '\n')
  if (sink !== undefined) await sink.emit(Channel.STDOUT, header)
  const job = await abortable(jobTable.wait(target.id, sid, signal), signal)
  await jobTable.reap(target.id, sid)
  return [
    sink === undefined ? header : null,
    new IOResult({ exitCode: job.exitCode }),
    new ExecutionNode({ command: cmdStr, exitCode: job.exitCode }),
  ]
}
