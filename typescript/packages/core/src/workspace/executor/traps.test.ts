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
import { IOResult, materialize } from '../../io/types.ts'
import { CallStack } from '../../shell/call_stack.ts'
import { SessionState } from '../session/session.ts'
import type { ExecuteFn } from '../expand/types.ts'
import {
  clearTraps,
  ignoredSignals,
  inheritTraps,
  liftFunctionTraps,
  ownAction,
  restoreFunctionTraps,
  runExitTrap,
  startJobTraps,
} from './traps.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function makeSession(action: string | null = null): SessionState {
  const session = new SessionState({ sessionId: 's1' })
  session.exitTrap = action
  return session
}

interface Call {
  line: string
  stdin: unknown
  callStack: CallStack | undefined
}

function recorder(result: IOResult): { run: ExecuteFn; calls: Call[] } {
  const calls: Call[] = []
  const run: ExecuteFn = (line, opts) => {
    calls.push({ line, stdin: opts.stdin, callStack: opts.callStack })
    return Promise.resolve(result)
  }
  return { run, calls }
}

describe('runExitTrap', () => {
  it('runs the action once in the frames given', async () => {
    const { run, calls } = recorder(new IOResult({ stdout: ENC.encode('bye\n') }))
    const session = makeSession('echo bye')
    const frames = new CallStack()
    frames.push(['a'], 'f')
    const stdin = ENC.encode('in')
    const cleanup = await runExitTrap(run, session, 7, stdin, frames)
    expect(DEC.decode(await materialize(cleanup?.stdout))).toBe('bye\n')
    expect(cleanup?.exitCode).toBe(7)
    expect(session.lastExitCode).toBe(7)
    expect(calls).toEqual([{ line: 'echo bye', stdin, callStack: frames }])
    expect(session.exitTrap).toBeNull()
    expect(await runExitTrap(run, session, 7)).toBeNull()
  })
})

describe('liftFunctionTraps', () => {
  type Pair = [string | null, string | null]
  it.each<[boolean, Pair, Pair, Pair]>([
    [false, [null, null], [null, null], ['echo e', 'echo r']],
    [false, [null, null], ['echo f', ''], ['echo f', '']],
    [true, ['echo e', 'echo r'], [null, null], ['echo e', 'echo r']],
  ])('lifts ERR and RETURN unless traced (%j)', (traced, inside, body, after) => {
    const session = makeSession()
    session.errTrap = 'echo e'
    session.returnTrap = 'echo r'
    session.shellOptions.errtrace = traced
    session.shellOptions.functrace = traced
    const lifted = liftFunctionTraps(session)
    expect([session.errTrap, session.returnTrap]).toEqual(inside)
    if (!traced) [session.errTrap, session.returnTrap] = body
    restoreFunctionTraps(session, lifted)
    expect([session.errTrap, session.returnTrap]).toEqual(after)
  })
})

describe('startJobTraps', () => {
  it.each<[boolean, boolean, [number, string][]]>([
    [
      true,
      false,
      [
        [15, ''],
        [2, ''],
      ],
    ],
    [
      false,
      false,
      [
        [15, ''],
        [2, 'echo i'],
      ],
    ],
    [
      true,
      true,
      [
        [15, ''],
        [2, 'echo i'],
      ],
    ],
  ])("lists a job's INT ignore when it runs commands (%j, %j)", (lists, monitor, traps) => {
    const session = makeSession()
    session.signalTraps = new Map([
      [15, ''],
      [2, 'echo i'],
    ])
    session.shellOptions.monitor = monitor
    startJobTraps(session, lists)
    expect([...session.signalTraps]).toEqual(traps)
    expect([...session.jobIgnored]).toEqual(new Map(traps).get(2) === '' ? [2] : [])
  })

  it("drops the ignore in a shell outside the job's process", () => {
    const job = makeSession()
    startJobTraps(job, true)
    startJobTraps(job, false)
    expect([[...job.signalTraps], [...job.jobIgnored]]).toEqual([[], []])
    const child = makeSession()
    startJobTraps(child, true)
    inheritTraps(child)
    expect([[...child.signalTraps], [...child.jobIgnored]]).toEqual([[], []])
    const shell = makeSession()
    startJobTraps(shell, true)
    clearTraps(shell)
    expect([[...shell.signalTraps], [...shell.entryIgnored]]).toEqual([[], []])
  })
})

describe('ignoredSignals', () => {
  it('passes on what a shell ignores but KILL and STOP', () => {
    const session = makeSession()
    session.signalTraps = new Map([
      [9, ''],
      [15, ''],
      [19, ''],
      [2, ''],
      [10, 'echo u'],
    ])
    session.jobIgnored = new Set([2])
    expect([...ignoredSignals(session)]).toEqual([15])
  })
})

describe('ownAction', () => {
  it("counts only a shell's own action as its own", () => {
    const session = makeSession()
    session.signalTraps = new Map([
      [10, 'echo u'],
      [15, ''],
    ])
    expect([10, 15, 1].map((s) => ownAction(session, s))).toEqual([true, false, false])
    session.signalTrapsInherited = true
    expect(ownAction(session, 10)).toBe(false)
  })
})
