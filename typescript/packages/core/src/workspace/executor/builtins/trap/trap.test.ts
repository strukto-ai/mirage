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
import { eventOf, handleTrap } from './trap.ts'
import { TrapEvent } from './types.ts'

const DEC = new TextDecoder()
const USAGE = 'trap: usage: trap [-lp] [[arg] signal_spec ...]\n'

function makeSession(): SessionState {
  return new SessionState({ sessionId: 's1' })
}

function stderr(io: { stderr: unknown }): string {
  return io.stderr instanceof Uint8Array ? DEC.decode(io.stderr) : ''
}

describe('eventOf', () => {
  it.each([
    ['EXIT', TrapEvent.Exit],
    ['exit', TrapEvent.Exit],
    ['0', TrapEvent.Exit],
    ['00', TrapEvent.Exit],
    ['TERM', TrapEvent.Other],
    ['sigint', TrapEvent.Other],
    ['ERR', TrapEvent.Err],
    ['return', TrapEvent.Return],
    ['DEBUG', TrapEvent.Other],
    ['15', TrapEvent.Other],
    ['RTMIN+3', TrapEvent.Other],
    ['SIGEXIT', null],
    ['65', null],
    ['FOO', null],
  ])('reads %s as bash does', (spec, event) => {
    expect(eventOf(spec)).toBe(event)
  })
})

describe('handleTrap', () => {
  it('registers and lists with bash quoting', () => {
    const session = makeSession()
    const [, io] = handleTrap(["printf '%s' x", 'EXIT'], session)
    expect(io.exitCode).toBe(0)
    expect(session.exitTrap).toBe("printf '%s' x")
    const row = "trap -- 'printf '\\''%s'\\'' x' EXIT\n"
    const [out] = handleTrap(['-p', 'EXIT', '0'], session)
    expect(DEC.decode(out as Uint8Array)).toBe(row + row)
    const [all] = handleTrap([], session)
    expect(DEC.decode(all as Uint8Array)).toBe(row)
  })

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

  it('keeps and lists an empty action', () => {
    const session = makeSession()
    handleTrap(['', 'EXIT'], session)
    const [out] = handleTrap(['-p'], session)
    expect(DEC.decode(out as Uint8Array)).toBe("trap -- '' EXIT\n")
  })

  it('takes ownership from the parent when it registers', () => {
    const session = makeSession()
    session.exitTrap = 'echo parent'
    session.exitTrapInherited = true
    handleTrap(['echo child', 'EXIT'], session)
    expect(session.exitTrap).toBe('echo child')
    expect(session.exitTrapInherited).toBe(false)
  })

  it('answers a lone action with usage', () => {
    const [, io] = handleTrap(['echo BAD'], makeSession())
    expect(io.exitCode).toBe(2)
    expect(stderr(io)).toBe(USAGE)
  })

  it('prints usage for an invalid option', () => {
    const [, io] = handleTrap(['-z'], makeSession())
    expect(io.exitCode).toBe(2)
    expect(stderr(io)).toBe('bash: trap: -z: invalid option\n' + USAGE)
  })

  it('refuses the signal list', () => {
    const [, io] = handleTrap(['-l'], makeSession())
    expect(io.exitCode).toBe(2)
    expect(stderr(io)).toBe('mirage: trap: -l: not supported\n')
  })

  it('refuses other events and still sets EXIT', () => {
    const session = makeSession()
    const [, io] = handleTrap(['echo x', 'TERM', 'FOO', 'EXIT'], session)
    expect(io.exitCode).toBe(1)
    expect(stderr(io)).toBe(
      'mirage: trap: TERM: not supported\n' + 'bash: trap: FOO: invalid signal specification\n',
    )
    expect(session.exitTrap).toBe('echo x')
  })

  it('treats resetting another event as a no-op', () => {
    const [, io] = handleTrap(['-', 'TERM'], makeSession())
    expect(io.exitCode).toBe(0)
  })
})
