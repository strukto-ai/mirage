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
import { CallStack } from '../../../../shell/call_stack.ts'
import { ExitSignal } from '../../../../shell/errors.ts'
import { SessionState } from '../../../session/session.ts'
import { ReturnSignal } from '../../../../shell/errors.ts'
import {
  handleColon,
  handleExit,
  handleFalse,
  handleReturn,
  handleTrue,
  loopLevels,
} from './control.ts'

const DEC = new TextDecoder()

function functionStack(): CallStack {
  const cs = new CallStack()
  cs.push([], 'f')
  return cs
}

describe('control builtins', () => {
  it('true, : and false carry a fixed status and no output', () => {
    expect(handleTrue()[1].exitCode).toBe(0)
    expect(handleTrue()[2].command).toBe('true')
    expect(handleColon()[1].exitCode).toBe(0)
    expect(handleColon()[2].command).toBe(':')
    expect(handleFalse()[1].exitCode).toBe(1)
    expect(handleFalse()[2].command).toBe('false')
    expect(handleFalse()[0]).toBeNull()
  })

  it('loopLevels reads a positive count and defaults to one', () => {
    expect(loopLevels([])).toBe(1)
    expect(loopLevels(['3'])).toBe(3)
    expect(loopLevels(['0'])).toBe(1)
    expect(loopLevels(['x'])).toBe(1)
    expect(loopLevels(['2', '9'])).toBe(2)
  })

  it('return outside a function fails with 2 and no signal', () => {
    const [out, io] = handleReturn([], new SessionState({ sessionId: 's1' }))
    expect(out).toBeNull()
    expect(io.exitCode).toBe(2)
    expect(DEC.decode(io.stderr as Uint8Array)).toContain("can only `return' from a function")
  })

  it('return in a function raises the signal with the status', () => {
    expect(() =>
      handleReturn(['7'], new SessionState({ sessionId: 's1' }), functionStack()),
    ).toThrow(ReturnSignal)
  })

  it('exit raises the signal, wrapping the status mod 256', () => {
    try {
      handleExit(['258'], new SessionState({ sessionId: 's1' }))
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(ExitSignal)
      expect((err as ExitSignal).exitCode).toBe(2)
    }
  })
})
