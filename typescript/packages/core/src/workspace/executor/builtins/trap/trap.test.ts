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

function makeSession(): SessionState {
  return new SessionState({ sessionId: 's1' })
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
})
