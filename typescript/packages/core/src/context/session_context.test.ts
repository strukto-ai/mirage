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
import {
  assertMountAllowed,
  effectiveMountMode,
  getCurrentSession,
  getCurrentSessionFor,
  MountNotAllowedError,
  runWithSession,
} from './session_context.ts'
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import { MountMode, weakerMode } from '../types.ts'
import { SessionManager } from '../workspace/session/manager.ts'
import { Session } from '../workspace/session/session.ts'

function grantedSession(): Session {
  return new Session({
    sessionId: 'agent',
    mountModes: new Map([
      ['/ro', MountMode.READ],
      ['/rw', MountMode.WRITE],
      ['/ex', MountMode.EXEC],
    ]),
  })
}

describe('weakerMode', () => {
  it('follows the READ < WRITE < EXEC lattice', () => {
    expect(weakerMode(MountMode.READ, MountMode.WRITE)).toBe(MountMode.READ)
    expect(weakerMode(MountMode.WRITE, MountMode.READ)).toBe(MountMode.READ)
    expect(weakerMode(MountMode.EXEC, MountMode.WRITE)).toBe(MountMode.WRITE)
    expect(weakerMode(MountMode.EXEC, MountMode.EXEC)).toBe(MountMode.EXEC)
  })
})

describe('session grants', () => {
  it('no bound session is unrestricted', () => {
    expect(() => {
      assertMountAllowed('/anything')
    }).not.toThrow()
    expect(effectiveMountMode('/anything', MountMode.WRITE)).toBe(MountMode.WRITE)
  })

  it('unrestricted session keeps the mount mode', async () => {
    await runWithSession(new Session({ sessionId: 'free' }), () => {
      expect(() => {
        assertMountAllowed('/s3')
      }).not.toThrow()
      expect(effectiveMountMode('/s3', MountMode.EXEC)).toBe(MountMode.EXEC)
      return Promise.resolve()
    })
  })

  it('missing grant denies visibility', async () => {
    await runWithSession(grantedSession(), () => {
      expect(() => {
        assertMountAllowed('/other')
      }).toThrow(MountNotAllowedError)
      return Promise.resolve()
    })
  })

  it('root mount is governed', async () => {
    await runWithSession(grantedSession(), () => {
      expect(() => {
        assertMountAllowed('/')
      }).toThrow(MountNotAllowedError)
      return Promise.resolve()
    })
  })

  it('grant narrows the mount mode', async () => {
    await runWithSession(grantedSession(), () => {
      expect(effectiveMountMode('/ro', MountMode.WRITE)).toBe(MountMode.READ)
      expect(effectiveMountMode('/rw', MountMode.EXEC)).toBe(MountMode.WRITE)
      return Promise.resolve()
    })
  })

  it('grant cannot widen the mount mode', async () => {
    await runWithSession(grantedSession(), () => {
      expect(effectiveMountMode('/ex', MountMode.READ)).toBe(MountMode.READ)
      expect(effectiveMountMode('/rw', MountMode.READ)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('normalizes prefixes before lookup', async () => {
    await runWithSession(grantedSession(), () => {
      expect(() => {
        assertMountAllowed('/ro/')
      }).not.toThrow()
      expect(() => {
        assertMountAllowed('ro')
      }).not.toThrow()
      expect(effectiveMountMode('/ro/', MountMode.WRITE)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('missing grant defaults effective mode to READ', async () => {
    await runWithSession(grantedSession(), () => {
      expect(effectiveMountMode('/other', MountMode.EXEC)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })
})

describe('a binding belongs to the workspace that published it', () => {
  it('answers only its own manager', async () => {
    const mine = new SessionManager('default')
    const theirs = new SessionManager('default')
    const session = new Session({ sessionId: 'default' })
    await runWithSession(
      session,
      () => {
        expect(getCurrentSessionFor(mine)).toBe(session)
        expect(getCurrentSessionFor(theirs)).toBeNull()
        expect(getCurrentSession()).toBe(session)
        return Promise.resolve()
      },
      mine,
    )
  })

  it('a nested bind keeps the owner', async () => {
    // A background job's fork is still the workspace's own session.
    const mine = new SessionManager('default')
    const outer = new Session({ sessionId: 'default' })
    const inner = new Session({ sessionId: 'default' })
    await runWithSession(
      outer,
      () =>
        runWithSession(inner, () => {
          expect(getCurrentSessionFor(mine)).toBe(inner)
          return Promise.resolve()
        }),
      mine,
    )
  })

  it('an unowned bind answers nobody', async () => {
    // The op-dispatch binders name no owner, so no line adopts one.
    await runWithSession(new Session({ sessionId: 'default' }), () => {
      expect(getCurrentSessionFor(new SessionManager('default'))).toBeNull()
      return Promise.resolve()
    })
  })

  it('node isolates concurrent tasks', () => {
    // What lets a background job bind its fork without the foreground
    // seeing it; the browser fallback storage cannot, and jobs.ts
    // reads this to decide.
    expect(asyncContextIsolatesTasks).toBe(true)
  })
})
