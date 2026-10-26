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

import { ExecutionFrame } from '../frame.ts'
import { describe, expect, it } from 'vitest'

import { IOResult } from '../../io/types.ts'
import { SessionState } from '../session/session.ts'
import { newStatusWriter } from '../abort.ts'
import {
  assignmentStatus,
  errexitActs,
  finishStatement,
  forks,
  ignoringErrexit,
  land,
  landLate,
  recordJobs,
  restoreStatus,
  snapshotStatus,
  statementOutput,
} from './statement.ts'
import { Channel, JobOutput } from '../../shell/console/index.ts'
import { Recorder } from '../../shell/descriptors.ts'
import { materialize } from '../../io/types.ts'
import { parse } from '../../shell/parse/parse.ts'

const decode = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array())

describe('finishStatement', () => {
  it('seeds $? for a null stdout', async () => {
    const session = new SessionState({ sessionId: 't' })
    const io = new IOResult({ exitCode: 1 })
    const out = await finishStatement(null, io, session)
    expect((out as Uint8Array).byteLength).toBe(0)
    expect(session.lastExitCode).toBe(1)
  })

  it('pulls lazily finalized exit codes before seeding', async () => {
    const session = new SessionState({ sessionId: 't' })
    const source = new IOResult({ exitCode: 0 })
    const merged = await new IOResult().merge(source)
    async function* gen(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      yield new TextEncoder().encode('out')
      source.exitCode = 4
    }
    const out = await finishStatement(gen(), merged, session)
    expect(decode(out as Uint8Array | null)).toBe('out')
    expect(merged.exitCode).toBe(4)
    expect(session.lastExitCode).toBe(4)
  })
})

describe('assignmentStatus', () => {
  it('tracks command substitutions run during expansion', () => {
    const frame = new ExecutionFrame()
    expect(assignmentStatus(frame, frame.cmdsubSeq)).toBe(0)
    const seq = frame.cmdsubSeq
    frame.cmdsubSeq += 1
    frame.cmdsubStatus = 5
    expect(assignmentStatus(frame, seq)).toBe(5)
    expect(assignmentStatus(frame, frame.cmdsubSeq)).toBe(0)
  })
})

describe('snapshotStatus / restoreStatus', () => {
  it('puts back the captured shell status', () => {
    const session = new SessionState({ sessionId: 't' })
    session.lastExitCode = 3
    session.pipeStatus = [0, 3]
    const before = snapshotStatus(session)
    session.lastExitCode = 0
    session.pipeStatus = [0]
    session.pipeStatusPending = [1]
    restoreStatus(session, before, null)
    expect(session.lastExitCode).toBe(3)
    expect(session.pipeStatus).toEqual([0, 3])
    expect(session.pipeStatusPending).toBeNull()
  })

  // Two `execute()` calls can share a session, and a snapshot taken
  // before a concurrent line finished is older than that line's result.
  // Putting it back would resurrect a value the shell moved past.
  it('declines to restore over a status another line stamped', () => {
    const session = new SessionState({ sessionId: 't' })
    const mine = newStatusWriter()
    const theirs = newStatusWriter()
    session.lastExitCode = 1
    const before = snapshotStatus(session)

    // The other line finishes and stamps 0.
    session.lastExitCode = 0
    session.pipeStatus = [0]
    session.statusWriter = theirs

    restoreStatus(session, before, mine)
    expect(session.lastExitCode).toBe(0)
    expect(session.pipeStatus).toEqual([0])

    // The line that did stamp last still puts its own back.
    restoreStatus(session, before, theirs)
    expect(session.lastExitCode).toBe(1)
  })
})

describe('forks', () => {
  it.each([
    ['head -c 1 f', null, true],
    ['(printf x)', null, true],
    ['printf x', null, false],
    ['g', null, false],
    ['command g', null, true],
    ['command -v head', null, false],
    ['{ head f; }', null, false],
    ['x=1', null, false],
    ['$cmd x', null, true],
    ['$cmd x', ['printf', 'x'], false],
    ['$cmd x', ['head', 'x'], true],
    ['$c head', ['command', 'head'], true],
    ['$f', ['g'], false],
  ] as const)('%s with %j: %s', (line, words, forked) => {
    const session = new SessionState({ sessionId: 's', functions: { g: 'g() { :; }' } })
    const node = parse(line).children[0]
    expect(node !== undefined && forks(node, session, words)).toBe(forked)
  })
})

describe('errexitActs', () => {
  it.each([
    ['false', 1, true, true],
    ['false', 0, true, false],
    ['false', 1, false, false],
    ['! true', 1, true, false],
  ] as const)('%s, status %d, errexit %s: %s', (line, status, errexit, acts) => {
    const session = new SessionState({ sessionId: 's', shellOptions: { errexit } })
    const node = parse(line).children[0]
    expect(node !== undefined && errexitActs(node, status, session)).toBe(acts)
  })

  it('is scoped off inside an ignored context', async () => {
    const session = new SessionState({ sessionId: 's', shellOptions: { errexit: true } })
    const node = parse('false').children[0]
    if (node === undefined) throw new Error('no statement')
    await ignoringErrexit(session, async () => {
      expect(errexitActs(node, 1, session)).toBe(false)
      await ignoringErrexit(session, () => Promise.resolve())
      expect(session.errexitIgnored).toBe(true)
    })
    expect(errexitActs(node, 1, session)).toBe(true)
  })
})

it('lands a job write made before its statement landed after the statement', async () => {
  // A job that writes after the statement's output was taken but before it
  // landed lands after it; one that writes once the recording ended goes
  // straight on to the shell.
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
  const session = new SessionState({ sessionId: 't' })
  const shell = new Recorder()
  const jobs = new JobOutput(shell)
  session.jobOutput = jobs
  const recorder = new Recorder()
  const leave = recordJobs(session, recorder)
  await jobs.emit(Channel.STDOUT, encode('statement\n'))
  const written = await statementOutput(recorder, null, new IOResult(), null, shell)
  await jobs.emit(Channel.STDOUT, encode('late\n'))
  const merged = await land(written, shell, [], new IOResult())
  await landLate(recorder, leave, null, shell, [], merged)
  await jobs.emit(Channel.STDOUT, encode('after\n'))
  const out: string[] = []
  for (const [, data] of await shell.take()) out.push(decode(await materialize(data)))
  expect(out.join('')).toBe('statement\nlate\nafter\n')
})

it('keeps a job write made once the recording ended behind what it recorded', async () => {
  // What a job writes once the recording ended waits until what was
  // recorded has landed, so it cannot overtake it.
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
  const session = new SessionState({ sessionId: 't' })
  const shell = new Recorder()
  const jobs = new JobOutput(shell)
  session.jobOutput = jobs
  const recorder = new Recorder()
  const leave = recordJobs(session, recorder)
  await jobs.emit(Channel.STDOUT, encode('a\n'))
  await jobs.emit(Channel.STDOUT, encode('b\n'))
  const landing = landLate(recorder, leave, null, shell, [], new IOResult())
  const late = jobs.emit(Channel.STDOUT, encode('c\n'))
  await landing
  await late
  const out: string[] = []
  for (const [, data] of await shell.take()) out.push(decode(await materialize(data)))
  expect(out.join('')).toBe('a\nb\nc\n')
})
