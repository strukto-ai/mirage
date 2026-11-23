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
import { SessionState } from '../../../session/session.ts'
import { startJobTraps } from '../../traps.ts'
import { eventOf, handleTrap } from './trap.ts'
import { TrapEvent } from './types.ts'

function makeSession(): SessionState {
  return new SessionState({ sessionId: 's1' })
}

describe('eventOf', () => {
  it.each([
    ['EXIT', TrapEvent.Exit],
    ['exit', TrapEvent.Exit],
    ['0', TrapEvent.Exit],
    ['00', TrapEvent.Exit],
    ['TERM', 15],
    ['sigint', 2],
    ['ERR', TrapEvent.Err],
    ['return', TrapEvent.Return],
    ['DEBUG', TrapEvent.Debug],
    ['15', 15],
    ['RTMIN+3', 37],
    [`RTMIN+${'0'.repeat(5000)}1`, 35],
    [`RTMAX-${'0'.repeat(5000)}1`, null],
    [`${'0'.repeat(5000)}15`, 15],
    ['SIGEXIT', null],
    ['65', null],
    ['FOO', null],
    // bash 5.2 takes the names `trap -l` lists and no other: IO and STKFLT,
    // but not the IOT, CLD or POLL timeout also takes.
    ['IO', 29],
    ['sigstkflt', 16],
    ['IOT', null],
    ['SIGCLD', null],
    ['POLL', null],
  ])('reads %s as bash does', (spec, event) => {
    expect(eventOf(spec)).toBe(event)
  })

  it('reads numbers past any digit limit as bash does', () => {
    // bash 5.2 reads 5,000 leading zeros as nothing, and 5,000 digits as no
    // signal. Mirrors test_trap.py.
    expect(eventOf('0'.repeat(5000))).toBe(TrapEvent.Exit)
    expect(eventOf('0'.repeat(5000) + '9')).toBe(9)
    expect(eventOf('9'.repeat(5000))).toBeNull()
  })
})

describe('handleTrap', () => {
  it.each([[['-', 'EXIT']], [['EXIT']], [['0']], [['--', '-', 'EXIT']]])(
    'reset form %j clears the action',
    (args) => {
      const session = makeSession()
      session.exitTrap = 'echo x'
      const [, io] = handleTrap(args, session)
      expect(io.exitCode).toBe(0)
      expect(session.exitTrap).toBeNull()
    },
  )

  it('treats resetting another event as a no-op', () => {
    const [, io] = handleTrap(['-', 'TERM'], makeSession())
    expect(io.exitCode).toBe(0)
  })

  it('lists signal actions by number between EXIT and ERR', () => {
    const session = makeSession()
    for (const args of [
      ['t', 'TERM'],
      ['h', '1'],
      [':', 'EXIT'],
      ['e', 'ERR'],
    ])
      handleTrap(args, session)
    const [out, io] = handleTrap(['-p'], session)
    expect(io.exitCode).toBe(0)
    expect(new TextDecoder().decode(out as Uint8Array)).toBe(
      "trap -- ':' EXIT\ntrap -- 'h' SIGHUP\ntrap -- 't' SIGTERM\ntrap -- 'e' ERR\n",
    )
  })

  it('keeps a signal ignored as the shell started ignored', () => {
    const session = makeSession()
    session.signalTraps = new Map([[2, '']])
    session.entryIgnored = new Set([2])
    handleTrap(['echo int', 'INT'], session)
    handleTrap(['-', 'INT'], session)
    expect([...session.signalTraps]).toEqual([[2, '']])
  })
})

describe('job INT ignore', () => {
  it('lists until the job resets it', () => {
    const session = makeSession()
    startJobTraps(session, true)
    const [out] = handleTrap(['-p'], session)
    expect(new TextDecoder().decode(out as Uint8Array)).toBe("trap -- '' SIGINT\n")
    handleTrap(['-', 'INT'], session)
    expect([[...session.signalTraps], [...session.jobIgnored]]).toEqual([[], []])
  })
})

describe('catchSignal', () => {
  it('takes caught and ignored signals only', () => {
    const session = makeSession()
    session.signalTraps = new Map([
      [15, 'echo t'],
      [10, ''],
    ])
    expect(session.catchSignal(15, 1)).toBe(true)
    expect([...session.pendingSignals]).toEqual([15])
    expect(session.catchSignal(10, 1)).toBe(false)
    expect(session.catchSignal(2, 1)).toBeNull()
    session.processId = 7
    expect(session.catchSignal(15, 1)).toBeNull()
    session.signalTrapsInherited = true
    expect(session.catchSignal(15, 7)).toBeNull()
    expect(session.catchSignal(10, 7)).toBe(false)
  })
})

describe('takesFatalSignal', () => {
  it("takes a fatal signal for the shell's own EXIT action only", () => {
    const session = makeSession()
    session.processId = 7
    session.lastExitCode = 4
    for (const [action, inherited] of [
      [null, false],
      ['', false],
      ['echo b', true],
    ] as const) {
      session.exitTrap = action
      session.exitTrapInherited = inherited
      expect(session.takesFatalSignal(15, 7)).toBe(false)
    }
    session.exitTrapInherited = false
    expect(session.takesFatalSignal(15, 8)).toBe(false)
    expect(session.takesFatalSignal(15, 7)).toBe(true)
    session.lastExitCode = 143
    expect(session.takesFatalSignal(1, 7)).toBe(true)
    expect([session.fatalSignal, session.statusBeforeSignal]).toEqual([15, 4])
  })
})
