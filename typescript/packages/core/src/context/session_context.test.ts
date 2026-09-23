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
  effectiveMountMode,
  effectivePathMode,
  getAdmission,
  getCurrentSession,
  getCurrentSessionFor,
  getCurrentSessionUnlessForeign,
  getOpPolicies,
  hiddenPathsActive,
  hiddenPathsIntersect,
  hiddenRefusal,
  pathAllowed,
  pathRulesActive,
  readonlyBelow,
  requireMountWritable,
  runWithAdmission,
  runWithMountGate,
  runWithOpPolicies,
  runWithSession,
  sessionPathAllowed,
  strongestModeUnder,
} from './session_context.ts'
import { asyncContextIsolatesTasks } from '../utils/async_context.ts'
import { Policies } from '../policy/policies.ts'
import { MountMode, weakerMode } from '../types.ts'
import { SessionManager } from '../workspace/session/manager.ts'
import { SessionState } from '../workspace/session/session.ts'

function narrowedSession(): SessionState {
  return new SessionState({
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

describe('a profile narrows the mounts it names', () => {
  it('no bound session is unrestricted', () => {
    expect(effectiveMountMode('/anything', MountMode.WRITE)).toBe(MountMode.WRITE)
  })

  it('a profile naming no mount keeps every mode', async () => {
    await runWithSession(new SessionState({ sessionId: 'free' }), () => {
      expect(effectiveMountMode('/s3', MountMode.EXEC)).toBe(MountMode.EXEC)
      return Promise.resolve()
    })
  })

  it('narrows the mount mode', async () => {
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/ro', MountMode.WRITE)).toBe(MountMode.READ)
      expect(effectiveMountMode('/rw', MountMode.EXEC)).toBe(MountMode.WRITE)
      return Promise.resolve()
    })
  })

  it('cannot widen the mount mode', async () => {
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/ex', MountMode.READ)).toBe(MountMode.READ)
      expect(effectiveMountMode('/rw', MountMode.READ)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('normalizes prefixes before lookup', async () => {
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/ro/', MountMode.WRITE)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('a mount the profile does not name keeps its own mode', async () => {
    // Naming three mounts is not an allowlist: a fourth is reachable at
    // whatever the workspace gave it. A profile that must not touch a
    // mount hides it, which reads as ENOENT rather than as a permission
    // error naming something the profile cannot see.
    await runWithSession(narrowedSession(), () => {
      expect(effectiveMountMode('/other', MountMode.EXEC)).toBe(MountMode.EXEC)
      expect(effectiveMountMode('/', MountMode.WRITE)).toBe(MountMode.WRITE)
      return Promise.resolve()
    })
  })
})

describe('a binding belongs to the workspace that published it', () => {
  it('answers only its own manager', async () => {
    const mine = new SessionManager('default')
    const theirs = new SessionManager('default')
    const session = new SessionState({ sessionId: 'default' })
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
    const outer = new SessionState({ sessionId: 'default' })
    const inner = new SessionState({ sessionId: 'default' })
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
    await runWithSession(new SessionState({ sessionId: 'default' }), () => {
      expect(getCurrentSessionFor(new SessionManager('default'))).toBeNull()
      return Promise.resolve()
    })
  })

  it("the op door keeps any bind but another owner's", async () => {
    // A kernel mount and a guest runtime bind without an owner, and
    // the door keeps those; only a binding another workspace made is
    // refused, since its session describes that workspace's view.
    const mine = new SessionManager('default')
    const theirs = new SessionManager('default')
    const session = new SessionState({ sessionId: 'default' })
    expect(getCurrentSessionUnlessForeign(mine)).toBeNull()
    await runWithSession(session, () => {
      expect(getCurrentSessionUnlessForeign(mine)).toBe(session)
      return Promise.resolve()
    })
    await runWithSession(
      session,
      () => {
        expect(getCurrentSessionUnlessForeign(mine)).toBe(session)
        expect(getCurrentSessionUnlessForeign(theirs)).toBeNull()
        return Promise.resolve()
      },
      mine,
    )
  })

  it('node isolates concurrent tasks', () => {
    // What lets a background job bind its fork without the foreground
    // seeing it; the browser fallback storage cannot, and jobs.ts
    // reads this to decide.
    expect(asyncContextIsolatesTasks).toBe(true)
  })
})

describe('hides', () => {
  it("a profile's hides reach the predicate as paths and patterns", async () => {
    // One list per session, built by the compiler from the profile's own
    // `paths.hide` and every mount section's, exact entries and glob
    // patterns told apart once by `classifyPaths`.
    const sess = new SessionState({
      sessionId: 'agent',
      hiddenPaths: {
        paths: ['/a/secrets', '/shared/finance'],
        patterns: ['/repo/*.pem'],
      },
    })
    await runWithSession(sess, () => {
      expect(hiddenPathsActive()).toBe(true)
      expect(pathAllowed('/a/secrets/x')).toBe(false)
      expect(pathAllowed('/shared/finance/q1.csv')).toBe(false)
      expect(pathAllowed('/repo/certs/k.pem')).toBe(false)
      expect(pathAllowed('/repo/README')).toBe(true)
      expect(pathAllowed('/shared/public')).toBe(true)
      return Promise.resolve()
    })
  })

  it('the explicit-session predicate answers without a binding', async () => {
    // A door that holds the session (the admission gate) asks it
    // directly; the bound form is the same answer for the bound
    // session, and no session bound means nothing is hidden.
    const sess = new SessionState({
      sessionId: 'agent',
      hiddenPaths: { paths: ['/a/secrets'], patterns: ['*.pem'] },
    })
    expect(getCurrentSession()).toBeNull()
    expect(sessionPathAllowed(sess, '/a/secrets/x')).toBe(false)
    expect(sessionPathAllowed(sess, '/repo/k.pem')).toBe(false)
    expect(sessionPathAllowed(sess, '/a/public')).toBe(true)
    expect(pathAllowed('/a/secrets/x')).toBe(true)
    await runWithSession(sess, () => {
      expect(pathAllowed('/a/secrets/x')).toBe(false)
      expect(pathAllowed('/a/public')).toBe(true)
      return Promise.resolve()
    })
  })

  it('a hidden create is refused by what its parent answers', async () => {
    // A create under a hidden directory is ENOENT, the answer every
    // read gives for that directory, so probing creates cannot map a
    // profile's hidden prefixes; a hidden name under a visible parent
    // is EACCES, the way an existing file the session cannot write is.
    const sess = new SessionState({
      sessionId: 'agent',
      hiddenPaths: { paths: ['/w/vault', '/w/open/file.txt'], patterns: ['*.key'] },
    })
    await runWithSession(sess, () => {
      expect(hiddenRefusal('/w/vault/new.txt', true)).toMatchObject({
        code: 'ENOENT',
        message: '/w/vault/new.txt',
      })
      expect(hiddenRefusal('/w/vault/a/b', true)).toMatchObject({ code: 'ENOENT' })
      expect(hiddenRefusal('/w/vault', true)).toMatchObject({ code: 'EACCES' })
      expect(hiddenRefusal('/w/vault/', true)).toMatchObject({ code: 'EACCES' })
      expect(hiddenRefusal('/w/open/file.txt', true)).toMatchObject({ code: 'EACCES' })
      expect(hiddenRefusal('/w/open/new.key', true)).toMatchObject({ code: 'EACCES' })
      expect(hiddenRefusal('/w/vault/new.txt', false)).toMatchObject({ code: 'ENOENT' })
      expect(hiddenRefusal('/w/open/file.txt', false)).toMatchObject({ code: 'ENOENT' })
      return Promise.resolve()
    })
  })

  it('a hide activates the gate and a profile without one does not', async () => {
    const sess = new SessionState({ sessionId: 'agent', hiddenPaths: { paths: ['/repo/.env'] } })
    await runWithSession(sess, () => {
      expect(hiddenPathsActive()).toBe(true)
      expect(pathAllowed('/repo/.env')).toBe(false)
      expect(pathAllowed('/repo/.envrc')).toBe(true)
      return Promise.resolve()
    })
    await runWithSession(new SessionState({ sessionId: 'free' }), () => {
      expect(hiddenPathsActive()).toBe(false)
      expect(pathAllowed('/repo/.env')).toBe(true)
      return Promise.resolve()
    })
  })
})

describe('the path axis modes', () => {
  it('effectivePathMode is the anchor-depth rule', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      mountModes: new Map([['/repo', MountMode.READ]]),
      shownPaths: {
        entries: [
          { path: '/repo/build', mode: MountMode.WRITE },
          { path: '/repo/tools', mode: MountMode.EXEC },
        ],
      },
    })
    await runWithSession(sess, () => {
      // The mount cap holds where no deeper entry speaks...
      expect(effectivePathMode('/repo/README.md', '/repo', MountMode.EXEC)).toBe(MountMode.READ)
      // ...and the deeper show entry wins below its anchor.
      expect(effectivePathMode('/repo/build/out', '/repo', MountMode.EXEC)).toBe(MountMode.WRITE)
      expect(effectivePathMode('/repo/tools/go.py', '/repo', MountMode.EXEC)).toBe(MountMode.EXEC)
      // The configured mode stays the strongest answer possible.
      expect(effectivePathMode('/repo/tools/go.py', '/repo', MountMode.READ)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it("effectivePathMode without a session is the mount's own", () => {
    expect(effectivePathMode('/a/x', '/a', MountMode.WRITE)).toBe(MountMode.WRITE)
  })

  it('an equal-depth pair takes the weaker', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      mountModes: new Map([['/repo', MountMode.EXEC]]),
      shownPaths: { entries: [{ path: '/repo', mode: MountMode.READ }] },
    })
    await runWithSession(sess, () => {
      expect(effectivePathMode('/repo/x', '/repo', MountMode.EXEC)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('strongestModeUnder counts a show grant', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      mountModes: new Map([['/repo', MountMode.READ]]),
      shownPaths: { entries: [{ path: '/repo/build', mode: MountMode.WRITE }] },
    })
    await runWithSession(sess, () => {
      // The mount-wide mode is READ, but a deeper grant makes a write
      // command runnable; the op door then refuses per path.
      expect(strongestModeUnder('/repo', MountMode.EXEC)).toBe(MountMode.WRITE)
      // Capped by the configured mode, and other mounts unaffected.
      expect(strongestModeUnder('/repo', MountMode.READ)).toBe(MountMode.READ)
      expect(strongestModeUnder('/other', MountMode.READ)).toBe(MountMode.READ)
      return Promise.resolve()
    })
  })

  it('readonlyBelow blames the carved anchor', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      shownPaths: {
        entries: [
          { path: '/repo/tree/locked', mode: MountMode.READ },
          { path: '/repo/tree/locked/pub', mode: MountMode.WRITE },
        ],
      },
    })
    await runWithSession(sess, () => {
      // The anchor lies strictly below the operand, so a subtree
      // mutation over it is refused, and the deeper re-widening does
      // not clear it (the region between the two stays read-only).
      expect(readonlyBelow('/repo/tree', '/repo', MountMode.WRITE)).toBe('/repo/tree/locked')
      expect(readonlyBelow('/repo', '/repo', MountMode.WRITE)).toBe('/repo/tree/locked')
      // The operand itself or a sibling is the flat check's business.
      expect(readonlyBelow('/repo/tree/locked', '/repo', MountMode.WRITE)).toBeNull()
      expect(readonlyBelow('/repo/other', '/repo', MountMode.WRITE)).toBeNull()
      return Promise.resolve()
    })
    expect(readonlyBelow('/repo/tree', '/repo', MountMode.WRITE)).toBeNull()
  })

  it('readonlyBelow blames the operand for a pattern', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      shownPaths: { entries: [{ path: '/repo/*/locked', mode: MountMode.READ }] },
    })
    await runWithSession(sess, () => {
      // A pattern names no single anchor, so the operand is blamed
      // whenever the match space could reach below it.
      expect(readonlyBelow('/repo/tree', '/repo', MountMode.WRITE)).toBe('/repo/tree')
      expect(readonlyBelow('/other/tree', '/repo', MountMode.WRITE)).toBeNull()
      return Promise.resolve()
    })
  })

  it('requireMountWritable needs the broad grant', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      mountModes: new Map([['/trello', MountMode.READ]]),
      shownPaths: { entries: [{ path: '/trello/board', mode: MountMode.WRITE }] },
    })
    await runWithSession(sess, () =>
      runWithMountGate('/trello', MountMode.WRITE, () => {
        // The carve-out admits the command, but an id-addressed write
        // names no path, so only the mount-wide grant counts.
        expect(() => {
          requireMountWritable('/trello')
        }).toThrow(/read-only/)
        return Promise.resolve()
      }),
    )
    // Unrestricted (no session narrowing) writes pass, and with no
    // mount bound the check is inert.
    await runWithMountGate('/trello', MountMode.WRITE, () => {
      requireMountWritable('/trello')
      return Promise.resolve()
    })
    requireMountWritable('/trello')
  })
})

describe('the per-operand hide gate', () => {
  it('hiddenPathsIntersect answers per operand', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      hiddenPaths: { paths: ['/repo/.env'] },
    })
    await runWithSession(sess, () => {
      expect(hiddenPathsIntersect('/repo')).toBe(true)
      expect(hiddenPathsIntersect('/repo/.env')).toBe(true)
      expect(hiddenPathsIntersect('/s3')).toBe(false)
      return Promise.resolve()
    })
    expect(hiddenPathsIntersect('/repo')).toBe(false)
  })

  it('a show reaches the session predicate', () => {
    const sess = new SessionState({
      sessionId: 'agent',
      hiddenPaths: { paths: ['/repo'] },
      shownPaths: { entries: [{ path: '/repo/public', mode: null }] },
    })
    expect(sessionPathAllowed(sess, '/repo/public/index.html')).toBe(true)
    expect(sessionPathAllowed(sess, '/repo')).toBe(true)
    expect(sessionPathAllowed(sess, '/repo/secrets')).toBe(false)
  })
})

describe('the admission binding', () => {
  it('is scoped to one command and hands the outer one back', async () => {
    const gate = (scoped: boolean) => ({ scoped, granted: [], check: () => undefined })
    expect(getAdmission()).toBeNull()
    expect(pathRulesActive()).toBe(false)
    const outer = gate(true)
    await runWithAdmission(outer, async () => {
      expect(getAdmission()).toBe(outer)
      expect(pathRulesActive()).toBe(true)
      // A nested line binds its own and hands the outer one back.
      const inner = gate(false)
      await runWithAdmission(inner, () => {
        expect(getAdmission()).toBe(inner)
        expect(pathRulesActive()).toBe(false)
        return Promise.resolve()
      })
      expect(getAdmission()).toBe(outer)
    })
    expect(getAdmission()).toBeNull()
    expect(pathRulesActive()).toBe(false)
  })
})

describe('the op-policies binding', () => {
  it('is scoped to one command', async () => {
    expect(getOpPolicies()).toBeNull()
    const policies = new Policies([])
    await runWithOpPolicies(policies, () => {
      expect(getOpPolicies()).toBe(policies)
      return Promise.resolve()
    })
    expect(getOpPolicies()).toBeNull()
  })
})
