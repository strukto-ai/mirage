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
import type { ProcessView } from '../../../execution/process/view.ts'
import { encodeText } from '../../../shell/bytes.ts'
import type { JobHandle, JobTable } from '../../../execution/job/index.ts'
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

/** The managed runners `ps` and numeric `kill` reach, scoped by the session's profile. */
export function processView(jobTable: JobTable, session: SessionState | null): ProcessView {
  return session === null
    ? jobTable.processes.view('')
    : jobTable.processes.view(session.sessionId, () => session.processes)
}

/**
 * The job whose number is `jobId`, the one `%N` names: none once its report
 * was printed, as bash then drops it from its list.
 */
export function jobNumbered(jobs: readonly JobHandle[], jobId: number): JobHandle | null {
  return jobs.find((j) => j.id === jobId && !j.reported) ?? null
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
    jobs.find((j) => j.process !== null && j.pid === pid) ??
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
  if (spec.startsWith('%')) {
    const raw = spec.slice(1)
    const job = /^[0-9]+$/.test(raw) ? jobNumbered(jobs, Number(raw)) : null
    return [job, job !== null ? '' : `${spec}: no such job`]
  }
  if (/^[0-9]+$/.test(spec)) {
    const job = jobWithPid(jobs, Number(spec))
    return [job, job !== null ? '' : `pid ${spec} is not a child of this shell`]
  }
  return [null, `\`${spec}': not a pid or valid job spec`]
}
