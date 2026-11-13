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
import { getCurrentEvaluation } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { concat } from '../../../../utils/bytes.ts'
import { NOT_FOUND_STATUS } from '../../../../shell/constants.ts'
import type { JobHandle, JobTable } from '../../../../execution/job/index.ts'
import { abortable } from '../../../../utils/abort.ts'
import type { SessionView } from '../../../../view/types.ts'
import { EvaluationContext } from '../../../evaluation.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { builtinUsage, identifierLine } from '../shared.ts'
import { reportJobs } from '../../background.ts'
import { IDENTIFIER_RE } from '../constants.ts'
import {
  AMBIGUOUS_SPEC,
  jobOfOperand,
  jobResult,
  savedOnMachine,
  scanningWhile,
  sessionOf,
} from '../jobspec.ts'
import { JUST_ENDED_SECONDS } from '../../../../execution/job/constants.ts'

/**
 * The job a bare `wait` leaves in the list for one `jobs`: the one `$!` names,
 * if it ended while another job still ran, or before the `wait` unless it is
 * the only job and only just ended. A job the `wait` ended on goes. Mirrors
 * Python's _left_listed.
 */
function leftListed(
  session: SessionState | null,
  jobs: readonly JobHandle[],
  began: number,
): number | null {
  const last = session?.lastBgJobId ?? null
  const job = jobs.find((j) => j.lastPid === last)
  const ended = job?.endedAt ?? null
  if (job === undefined || ended === null) return null
  if (jobs.some((j) => j.ending > job.ending)) return job.id
  if (ended > began) return null
  return jobs.length === 1 && began - ended < JUST_ENDED_SECONDS ? null : job.id
}

/**
 * Block until the first of several jobs ends, and return it. Once one has,
 * the other waits are abandoned, as `signal` abandons them all.
 */
async function waitFirst(
  jobTable: JobTable,
  jobs: JobHandle[],
  signal?: AbortSignal,
): Promise<JobHandle> {
  for (const job of jobs) {
    if (job.state !== 'running') return await jobTable.wait(job.id, job.sessionId, signal)
  }
  const losers = new AbortController()
  const done = signal === undefined ? losers.signal : AbortSignal.any([signal, losers.signal])
  try {
    return await Promise.race(jobs.map((job) => jobTable.wait(job.id, job.sessionId, done)))
  } finally {
    losers.abort()
  }
}

/**
 * Report one finished job's status, and reap it. Its output already went
 * where its shell writes as it was written.
 */
async function reaped(jobTable: JobTable, job: JobHandle, cmdStr: string): Promise<RedirectResult> {
  // Reaped like GNU bash reaps a job waited on by id, so a later bare
  // `wait` does not answer for it again.
  await jobTable.reap(job.id, job.sessionId)
  return [
    null,
    new IOResult({ exitCode: job.exitCode }),
    new ExecutionNode({ command: cmdStr, exitCode: job.exitCode }),
  ]
}

/**
 * Wait for background jobs, with bash's option surface. A job's output
 * went where its shell writes as it was written, so `wait` prints none,
 * as bash's does. Bare `wait` joins every job; `wait ID...` joins those
 * and answers the last one's status; `-n` joins the first of the given jobs
 * (or of all) to finish, 127 when there is nothing to wait for; `-p VAR`
 * stores the id of the job whose status is answered, unsetting VAR when
 * none is (which is the bare form, since it reports no one job); `-f` is
 * accepted, since a mirage job cannot stop, only end.
 *
 * `-p` stores the managed PID, matching `$!` and `jobs -p`.
 */
export async function handleWait(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  view: SessionView | null = null,
  signal?: AbortSignal,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  const shell = session?.processId ?? null
  let nextJob = false
  let machine: string | null = null
  let varName: string | null = null
  const specs: string[] = []
  let i = 1
  while (i < parts.length) {
    const word = parts[i] ?? ''
    if (specs.length > 0 || !word.startsWith('-') || word === '-') {
      specs.push(word)
      i++
      continue
    }
    if (word === '--') {
      for (const item of parts.slice(i + 1)) specs.push(item)
      break
    }
    if (word.startsWith('--machine=')) {
      machine = word.slice('--machine='.length)
      i++
      continue
    }
    if (word === '--machine') {
      if (i + 1 >= parts.length)
        return jobResult(
          cmdStr,
          `${shellVoice()}wait: --machine: option requires an argument\n${builtinUsage('wait')}`,
          2,
        )
      machine = parts[i + 1] ?? ''
      i += 2
      continue
    }
    let j = 1
    let bad: string | null = null
    while (j < word.length) {
      const ch = word[j] ?? ''
      if (ch === 'n') nextJob = true
      else if (ch === 'f') {
        // Waiting already lasts until a job ends, so `-f` is already true.
      } else if (ch === 'p' || ch === 'm') {
        let rest = word.slice(j + 1)
        if (rest === '' && i + 1 >= parts.length) {
          return jobResult(
            cmdStr,
            `${shellVoice()}wait: -${ch}: option requires an argument\n${builtinUsage('wait')}`,
            2,
          )
        }
        if (rest === '') {
          i++
          rest = parts[i] ?? ''
        }
        if (ch === 'p') varName = rest
        else machine = rest
        break
      } else {
        bad = ch
        break
      }
      j++
    }
    if (bad !== null) {
      return jobResult(
        cmdStr,
        `${shellVoice()}wait: -${bad}: invalid option\n${builtinUsage('wait')}`,
        2,
      )
    }
    i++
  }
  if (varName !== null) {
    if (!IDENTIFIER_RE.test(varName)) {
      return jobResult(cmdStr, `${identifierLine('wait', varName)}\n`, 1)
    }
    if (view?.isReadonly(varName) === true) {
      return jobResult(
        cmdStr,
        `${shellVoice()}wait: ${varName}: cannot unset: readonly variable\n`,
        1,
      )
    }
    if (view !== null) await view.unset(varName)
  }
  const errors: string[] = []
  const picked: JobHandle[] = []
  await jobTable.sync(sid)
  const visible = jobTable.listJobs(sid)
  const processes = jobTable.processes
  const marks = jobTable.jobMarks(sid)
  let answered: number | null = null
  let answeredPid = 0
  const named = new Map<number, number>()
  for (const spec of specs) {
    answered = null
    const numeric = /^[0-9]+$/.test(spec)
    const found = await jobOfOperand(processes, visible, spec, marks, machine)
    const job = found[0]
    let refusal = found[1]
    if (job !== null) {
      picked.push(job)
      if (numeric) named.set(job.id, Number(spec))
      continue
    }
    if (numeric && !refusal.endsWith(AMBIGUOUS_SPEC)) {
      answeredPid = Number(spec)
      if (!nextJob)
        await abortable(jobTable.waitSubstitution(sid, shell, answeredPid, signal), signal)
      const [saved, ambiguous] = savedOnMachine(jobTable.savedStatuses(sid, answeredPid), machine)
      answered = saved
      if (ambiguous) refusal = `${spec}: ${AMBIGUOUS_SPEC}`
    }
    if (answered === null) errors.push(`${shellVoice()}wait: ${refusal}`)
  }
  const errText = errors.length > 0 ? errors.join('\n') + '\n' : ''
  const errBytes = errText !== '' ? encodeText(errText) : null
  if (nextJob) {
    const candidates = specs.length > 0 ? picked : visible
    if (candidates.length === 0) {
      return [
        null,
        new IOResult({ exitCode: NOT_FOUND_STATUS, stderr: errBytes }),
        new ExecutionNode({ command: cmdStr, exitCode: NOT_FOUND_STATUS }),
      ]
    }
    const job = await scanningWhile(
      processes,
      abortable(waitFirst(jobTable, candidates, signal), signal),
    )
    if (varName !== null && view !== null)
      await view.set(varName, String(named.get(job.id) ?? job.shownPid))
    const told = waitReports(session, jobTable)
    const [stdout, io, node] = await reaped(jobTable, job, cmdStr)
    if (errBytes !== null || told.length > 0) {
      io.stderr = concat([errBytes ?? new Uint8Array(), told])
    }
    return [stdout, io, node]
  }
  if (specs.length === 0) {
    const began = jobTable.clock.now()
    await scanningWhile(processes, abortable(jobTable.waitAll(sid, signal), signal))
    const keep = leftListed(session, visible, began)
    const told = waitReports(session, jobTable)
    await jobTable.popCompleted(sid, keep)
    jobTable.forgetStatuses(sid)
    await abortable(jobTable.waitSubstitution(sid, shell, undefined, signal), signal)
    if (visible.length > 0) jobTable.forgetStatuses(sid)
    return [
      null,
      new IOResult({ stderr: told.length > 0 ? told : null }),
      new ExecutionNode({ command: cmdStr, exitCode: 0 }),
    ]
  }
  if (answered !== null && picked.length === 0) {
    const code = answered
    if (varName !== null && view !== null) await view.set(varName, String(answeredPid))
    return [
      null,
      new IOResult({ exitCode: code, stderr: errBytes }),
      new ExecutionNode({ command: cmdStr, exitCode: code }),
    ]
  }
  if (picked.length === 0) {
    // Every spec was refused: bash answers 127 for a job it cannot find
    // and 1 for a word that is not a spec at all, the last one deciding.
    const last = errors[errors.length - 1] ?? ''
    const code = last.endsWith('not a pid or valid job spec') ? 1 : NOT_FOUND_STATUS
    return jobResult(cmdStr, errText, code)
  }
  const finished: JobHandle[] = []
  for (const job of picked)
    finished.push(
      await scanningWhile(processes, abortable(jobTable.wait(job.id, sid, signal), signal)),
    )
  const told = waitReports(session, jobTable)
  let lastCode = 0
  let lastJob: JobHandle | null = null
  for (const job of finished) {
    const [, io] = await reaped(jobTable, job, cmdStr)
    lastCode = io.exitCode
    lastJob = job
  }
  if (answered !== null) lastCode = answered
  // `wait id1 id2` answers with the last id's status, so `-p` names that
  // same job however many were waited for. Only the no-operand form
  // leaves the variable unset, since it reports no one job.
  if (varName !== null && view !== null && lastJob !== null) {
    const pid = answered !== null ? answeredPid : (named.get(lastJob.id) ?? lastJob.shownPid)
    await view.set(varName, String(pid))
  }
  const stderr = concat([errBytes ?? new Uint8Array(), told])
  return [
    null,
    new IOResult({ exitCode: lastCode, stderr: stderr.length > 0 ? stderr : null }),
    new ExecutionNode({ command: cmdStr, exitCode: lastCode }),
  ]
}

/**
 * What `wait` tells of the jobs a signal ended once it waited (`reportJobs`),
 * before it reaps them. Mirrors Python's _wait_reports.
 */
function waitReports(session: SessionState | null, jobTable: JobTable): Uint8Array {
  if (session === null) return new Uint8Array()
  const current = getCurrentEvaluation()
  const context =
    current !== null && current.session === session ? current : new EvaluationContext(session)
  return reportJobs(context, jobTable)
}
