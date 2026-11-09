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
import { sessionVoice } from '../../../../context/session_context.ts'
import { IOResult } from '../../../../io/types.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { SIGTERM } from '../../../../shell/constants.ts'
import { listedSignal, signalNumber, signalTable } from '../../../../shell/signals.ts'
import type { JobHandle, JobTable } from '../../../../execution/job/index.ts'
import type { SessionView } from '../../../../view/types.ts'
import type { SessionState } from '../../../session/session.ts'
import { ExecutionNode } from '../../../types.ts'
import { builtinUsage } from '../shared.ts'
import { MAX_PID_OPERAND } from '../constants.ts'
import { grantsOf, jobOfSpec, jobResult, machineProcess, onMachine, sessionOf } from '../jobspec.ts'
import { FIRST_PID } from '../../../../execution/process/constants.ts'

/**
 * `kill -l`: the signal table, or each operand's name for a number (a `$?`
 * of 128 plus one too) and number for a name. Mirrors Python's _kill_list.
 */
function killList(cmdStr: string, operands: string[], voice: string): RedirectResult {
  const words = operands[0] === '--' ? operands.slice(1) : operands
  if (words.length === 0) {
    return [
      encodeText(signalTable()),
      new IOResult(),
      new ExecutionNode({ command: cmdStr, exitCode: 0 }),
    ]
  }
  const lines: string[] = []
  const errors: string[] = []
  for (const word of words) {
    const line = listedSignal(word)
    if (line === null) errors.push(`${voice}kill: ${word}: invalid signal specification`)
    else if (line !== '') lines.push(line)
  }
  const code = errors.length > 0 ? 1 : 0
  const err = encodeText(errors.map((line) => `${line}\n`).join(''))
  return [
    encodeText(lines.map((line) => `${line}\n`).join('')),
    new IOResult({ exitCode: code, ...(errors.length > 0 ? { stderr: err } : {}) }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: err }),
  ]
}

/**
 * The managed PID one kill operand names, or bash's refusal. A `%N` job
 * with no process, one restored from a snapshot, has ended: it answers
 * no such process, and never reaches the process table, where its
 * stand-in PID may name another process.
 */
function killPid(jobs: readonly JobHandle[], operand: string): [number | null, string] {
  if (operand === '') return [null, "`': not a pid or valid job spec"]
  if (operand.startsWith('%')) {
    const [job, refusal] = jobOfSpec(jobs, operand)
    if (job === null) return [null, refusal]
    if (job.process === null) return [null, `(${String(job.pid)}) - No such process`]
    return [job.pid, '']
  }
  const digits = operand.startsWith('-') ? operand.slice(1) : operand
  if (!/^[0-9]+$/.test(digits) || Number(digits) > MAX_PID_OPERAND)
    return [null, `${operand}: arguments must be process or job IDs`]
  return [Number(operand), '']
}

/**
 * Signal managed runners with bash's kill surface. The signal comes from
 * `-s`/`-n`, or from the first `-sigspec`; `0` probes, and each process
 * does what the signal does (`ProcessTable.signal`). A number under `FIRST_PID` is a machine pid
 * (`machineProcess`). Every operand is tried and each failure is
 * named in bash's words; the status is 0 when any operand was signalled,
 * as bash's is. A job spec is `%N`; a negative number is a process group,
 * the session's `-$$` among them, whose every runner gets the signal
 * (killpg). A signal that stops the shell running `kill` lands before the
 * next statement, as bash's signal to itself does: its abort fails that
 * statement's checkpoint.
 */
export async function handleKill(
  jobTable: JobTable,
  parts: string[],
  session: SessionState | null = null,
  _view: SessionView | null = null,
): Promise<RedirectResult> {
  const cmdStr = parts.join(' ')
  const sid = sessionOf(session)
  let signal = SIGTERM
  let words = parts.slice(1)
  let sawSignal = false
  let machine: string | null = null
  let named = ''
  // The program (`xargs kill`) keeps its bare voice.
  const voice = session === null ? shellVoice() : sessionVoice(session)
  if (words[0] === '-l' || words[0] === '-L') return killList(cmdStr, words.slice(1), voice)
  while (words.length > 0) {
    const word = words[0] ?? ''
    let spec: string
    if (word === '-s' || word === '-n') {
      if (words.length < 2)
        return jobResult(cmdStr, `${voice}kill: ${word}: option requires an argument\n`, 1)
      spec = words[1] ?? ''
      words = words.slice(2)
    } else if (word === '-m') {
      if (words.length < 2)
        return jobResult(cmdStr, `${voice}kill: -m: option requires an argument\n`, 1)
      machine = words[1] ?? ''
      words = words.slice(2)
      continue
    } else if (word === '--') {
      words = words.slice(1)
      break
    } else if (word === '-?') {
      return jobResult(cmdStr, builtinUsage('kill'), 2)
    } else if (
      (word.startsWith('-s') && /^[A-Za-z]/.test(word.slice(2))) ||
      (word.startsWith('-n') && /^[0-9]/.test(word.slice(2)))
    ) {
      spec = word.slice(2)
      words = words.slice(1)
    } else if (word.startsWith('-') && word.length > 1 && !sawSignal) {
      spec = word.slice(1)
      words = words.slice(1)
    } else break
    const number = signalNumber(spec)
    if (number === null)
      return jobResult(cmdStr, `${voice}kill: ${spec}: invalid signal specification\n`, 1)
    signal = number
    named = spec
    sawSignal = true
  }
  if (words.length === 0) return jobResult(cmdStr, builtinUsage('kill'), 2)
  const processes = jobTable.processes
  const errors: string[] = []
  let signalled = false
  await jobTable.sync(sid)
  for (const operand of words) {
    const jobs = jobTable.listJobs(sid)
    let [pid, refusal] = killPid(jobs, operand)
    const shown = new Map(jobs.map((job) => [job.pid, job.shownPid]))
    if (pid !== null && pid > 0 && pid < FIRST_PID && /^[0-9]+$/.test(operand)) {
      const [found, ambiguous] = await machineProcess(processes, session, pid, machine)
      if (ambiguous) {
        errors.push(`${voice}kill: ${operand}: ambiguous job spec`)
        continue
      }
      pid = found?.id.pid ?? null
      refusal = `(${operand}) - No such process`
    } else if (pid !== null && pid < 0 && pid > -FIRST_PID) {
      const [leader, ambiguous] = await machineProcess(processes, session, -pid, machine)
      if (ambiguous) {
        errors.push(`${voice}kill: ${operand}: ambiguous job spec`)
        continue
      }
      pid = leader !== null ? -leader.group : null
      refusal = `(${operand}) - No such process`
    } else if (pid !== null && pid > 0 && machine !== null) {
      await processes.scan()
      const target = pid
      const wanted = machine
      const seen = processes.visible(sid, grantsOf(session))
      if (!seen.some((info) => info.id.pid === target && onMachine(info, wanted))) {
        refusal = `(${operand}) - No such process`
        pid = null
      }
    }
    if (pid === null) {
      errors.push(`${voice}kill: ${refusal}`)
      continue
    }
    if (operand.startsWith('-')) {
      let found: boolean
      try {
        found = await killGroup(jobTable, session, jobs, -pid, signal)
      } catch (err) {
        if ((err as { code?: unknown }).code !== 'EPERM') throw err
        errors.push(`${voice}kill: (${operand}) - Operation not permitted`)
        continue
      }
      if (!found) {
        errors.push(`${voice}kill: (${operand}) - No such process`)
        continue
      }
      signalled = true
      continue
    }
    const label = /^[0-9]+$/.test(operand) ? operand : String(shown.get(pid) ?? pid)
    let found: boolean | null
    try {
      found = await signalOne(jobTable, session, jobs, pid, signal)
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'EPERM') throw err
      errors.push(`${voice}kill: (${label}) - Operation not permitted`)
      continue
    }
    if (found === null) {
      errors.push(`${voice}kill: ${named}: not supported`)
      continue
    }
    if (!found) {
      errors.push(`${voice}kill: (${label}) - No such process`)
      continue
    }
    signalled = true
  }
  const code = signalled ? 0 : 1
  const stderr = errors.length > 0 ? encodeText(errors.join('\n') + '\n') : null
  return [
    null,
    new IOResult({ exitCode: code, stderr }),
    new ExecutionNode({ command: cmdStr, exitCode: code, stderr: stderr ?? new Uint8Array() }),
  ]
}

/**
 * Signal one process the session may reach (`ProcessTable.signal`), its job
 * recorded as killed if that stopped it. Answers whether the process was
 * there to signal, null where a STOP cannot hold it. Mirrors Python's
 * _signal_one.
 */
async function signalOne(
  jobTable: JobTable,
  session: SessionState | null,
  jobs: JobHandle[],
  pid: number,
  signal: number,
): Promise<boolean | null> {
  const processes = jobTable.processes
  const sid = sessionOf(session)
  const handle = processes.target(pid, sid, grantsOf(session))
  if (handle === null) return false
  const found = await processes.signal(handle, signal)
  const job = jobs.find((j) => j.process !== null && j.pid === pid)
  if (found === true && job !== undefined && handle.record.state === 'stopping')
    await jobTable.kill(job.id, sid, handle.signal ?? signal)
  return found
}

/**
 * Signal a process group the session may reach as killpg(2) does, its jobs
 * Mirage stops recorded as killed by the signal. Returns whether the group
 * had a runner the session sees. Mirrors Python's _kill_group.
 */
async function killGroup(
  jobTable: JobTable,
  session: SessionState | null,
  jobs: JobHandle[],
  group: number,
  signal: number,
): Promise<boolean> {
  const processes = jobTable.processes
  const sid = sessionOf(session)
  const granted = grantsOf(session)
  if (processes.group(group, sid, granted) === null) return false
  if (signal === 0) return true
  await processes.scan()
  await processes.signalMembers(processes.group(group, sid, granted) ?? [], signal)
  for (const job of jobs) {
    if (
      job.process !== null &&
      job.process.record.group === group &&
      job.process.record.state === 'stopping'
    )
      await jobTable.kill(job.id, sid, job.process.signal ?? signal)
  }
  return true
}
