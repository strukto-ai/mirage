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

import { describe, expect, it } from 'vitest'

import { IOResult } from '../../io/types.ts'
import { Session, newStatusWriter } from '../session/session.ts'
import { assignmentStatus, finishStatement, restoreStatus, snapshotStatus } from './statement.ts'

const decode = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array())

describe('finishStatement', () => {
  it('materializes stdout and seeds $?', async () => {
    const session = new Session({ sessionId: 't' })
    session.lastExitCode = 7
    async function* gen(): AsyncGenerator<Uint8Array> {
      await Promise.resolve()
      yield new TextEncoder().encode('ab')
      yield new TextEncoder().encode('c')
    }
    const io = new IOResult({ exitCode: 3 })
    const out = await finishStatement(gen(), io, session)
    expect(decode(out as Uint8Array | null)).toBe('abc')
    expect(session.lastExitCode).toBe(3)
  })

  it('seeds $? for a null stdout', async () => {
    const session = new Session({ sessionId: 't' })
    const io = new IOResult({ exitCode: 1 })
    const out = await finishStatement(null, io, session)
    expect((out as Uint8Array).byteLength).toBe(0)
    expect(session.lastExitCode).toBe(1)
  })

  it('pulls lazily finalized exit codes before seeding', async () => {
    const session = new Session({ sessionId: 't' })
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
    const session = new Session({ sessionId: 't' })
    expect(assignmentStatus(session, session.cmdsubSeq)).toBe(0)
    const seq = session.cmdsubSeq
    session.cmdsubSeq += 1
    session.cmdsubStatus = 5
    expect(assignmentStatus(session, seq)).toBe(5)
    expect(assignmentStatus(session, session.cmdsubSeq)).toBe(0)
  })
})

describe('snapshotStatus / restoreStatus', () => {
  it('puts back the captured shell status', () => {
    const session = new Session({ sessionId: 't' })
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
    const session = new Session({ sessionId: 't' })
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
