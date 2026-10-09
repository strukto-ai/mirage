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
import type { ExecuteStringFn } from './builtins/types.ts'
import { liftFunctionTraps, restoreFunctionTraps, runExitTrap } from './traps.ts'

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

function recorder(result: IOResult): { run: ExecuteStringFn; calls: Call[] } {
  const calls: Call[] = []
  const run: ExecuteStringFn = (line, opts) => {
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
