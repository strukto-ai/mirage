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
import type { SessionView } from '../../ops/types.ts'
import { PolicyDenied } from '../../policy/errors.ts'
import { Policies } from '../../policy/policies.ts'
import type { Action, SessionContext } from '../../policy/types.ts'
import { ReadonlyVariableError } from './errors.ts'
import { Session } from './session.ts'
import { envSnapshot, sessionView } from './state.ts'

class DenySecrets {
  preSession(ctx: SessionContext): Action | null {
    if (ctx.key.startsWith('SECRET')) {
      return { kind: 'deny', message: 'SECRET_* refused by policy\n' }
    }
    return null
  }
}

function makeView(policies: Policies | null = null): [SessionView, Session] {
  const session = new Session({ sessionId: 's', cwd: '/', env: { A: '1' } })
  return [sessionView(session, policies), session]
}

describe('sessionView', () => {
  it('get and snapshot read the session', () => {
    const [view, session] = makeView()
    expect(view.get('A')).toBe('1')
    expect(view.get('MISSING')).toBeNull()
    const snap = view.snapshot()
    expect(snap.A).toBe('1')
    snap.B = '2'
    expect('B' in session.env).toBe(false)
  })

  it('set and unset write the session', async () => {
    const [view, session] = makeView()
    await view.set('B', '2')
    expect(session.env.B).toBe('2')
    await view.unset('B')
    expect('B' in session.env).toBe(false)
  })

  it('unset of a missing name is quiet', async () => {
    const [view] = makeView()
    await view.unset('NEVER_SET')
  })

  it('set is general over variable shapes', async () => {
    // One door for every write: a string stores a scalar, a list stores
    // a whole array, and the two storages stay exclusive.
    const [view, session] = makeView()
    await view.set('A', ['x', 'y'])
    expect(session.arrays.A).toEqual(['x', 'y'])
    expect('A' in session.env).toBe(false)
    await view.set('A', 's')
    expect(session.env.A).toBe('s')
    expect('A' in session.arrays).toBe(false)
  })

  it('an array write renders the gate value as words', async () => {
    const seen: (string | null)[] = []
    class Capture {
      preSession(ctx: SessionContext): Action | null {
        seen.push(ctx.value)
        return null
      }
    }
    const policies = new Policies()
    policies.add(new Capture())
    const [view] = makeView(policies)
    await view.set('A', ['x', null, 'y'])
    expect(seen).toEqual(['x y'])
  })

  it('the gate learns which session asked', async () => {
    const seen: string[] = []
    class CaptureSession {
      preSession(ctx: SessionContext): Action | null {
        seen.push(ctx.sessionId)
        return null
      }
    }
    const policies = new Policies()
    policies.add(new CaptureSession())
    const [view] = makeView(policies)
    await view.set('B', '1')
    expect(seen).toEqual(['s'])
  })

  it('readonly refusal is typed', async () => {
    // The view owns the refusal so every writer states it the same way;
    // builtins catch the typed error and render their own bash wording.
    const [view, session] = makeView()
    session.readonlyVars.add('A')
    expect(view.isReadonly('A')).toBe(true)
    await expect(view.set('A', '2')).rejects.toBeInstanceOf(ReadonlyVariableError)
    await expect(view.unset('A')).rejects.toBeInstanceOf(ReadonlyVariableError)
    expect(session.env.A).toBe('1')
  })

  it('preSession gate vetoes a write', async () => {
    const policies = new Policies()
    policies.add(new DenySecrets())
    const [view, session] = makeView(policies)
    await expect(view.set('SECRET_KEY', 'x')).rejects.toBeInstanceOf(PolicyDenied)
    expect('SECRET_KEY' in session.env).toBe(false)
    await expect(view.unset('SECRET_KEY')).rejects.toBeInstanceOf(PolicyDenied)
    await view.set('PUBLIC', 'y')
    expect(session.env.PUBLIC).toBe('y')
  })

  it('envSnapshot is a copy', () => {
    const session = new Session({ sessionId: 's', cwd: '/', env: { A: '1' } })
    const snap = envSnapshot(session)
    expect(snap).toEqual({ ...session.env })
    expect(snap).not.toBe(session.env)
  })

  it('the view carries no session handle', () => {
    // The view is the whole capability: five facts, no way back to the
    // raw session object behind them.
    const [view] = makeView()
    expect('session' in view).toBe(false)
  })
})
