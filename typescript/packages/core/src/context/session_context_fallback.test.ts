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

import { describe, expect, it, vi } from 'vitest'
import {
  getAdmission,
  getCurrentSessionFor,
  getOpPolicies,
  mountGateFor,
  pathAllowed,
  redirectPathsFor,
  redirectTargetJudged,
  requireMountWritable,
  runWithAdmission,
  runWithMountGate,
  runWithOpPolicies,
  runWithRedirectPaths,
  runWithSession,
  runWithSuspendedOpPolicies,
  sessionUmask,
} from './session_context.ts'
import type { EntryGate } from '../types.ts'
import { MountMode, PathSpec } from '../types.ts'
import type { CommandRule } from '../policy/types.ts'
import type { Policies } from '../policy/policies.ts'
import type { SessionManager } from '../workspace/session/manager.ts'
import { SessionState } from '../workspace/session/session.ts'
import { parseSessionProfile } from '../policy/profile.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import { Session } from '../workspace/workspace/handle.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import type * as asyncContextModule from '../utils/async_context.ts'

// The browser-runtime branch under node's test runner: the mock forces
// the real FallbackStorage (no task isolation, one frame stack per
// storage), so these tests pin what every ambient fact does where
// AsyncLocalStorage does not exist.
vi.mock('../utils/async_context.ts', async (importOriginal) => {
  const real = await importOriginal<typeof asyncContextModule>()
  return {
    ...real,
    asyncContextIsolatesTasks: false,
    createAsyncContext<T>() {
      return new real.FallbackStorage<T>()
    },
  }
})

/** A promise released by hand, for holding one run live inside another. */
function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return [held, release]
}

describe('the mount gate on the fallback storage', () => {
  it('overlapping commands each answer with their own mounts gate', async () => {
    // The corruption the slot would allow: while B runs, a slot read in
    // A's continuation sees B's gate, and A's protected path is judged
    // with B's prefix and mode. The live frames answer by the path.
    const [holdA, releaseA] = gate()
    const [holdB, releaseB] = gate()
    let gateInA: readonly [string, MountMode] | null = null
    let gateInB: readonly [string, MountMode] | null = null
    const cmdA = runWithMountGate('/a', MountMode.WRITE, async () => {
      await holdA
      // B is still mid-run here: both gates are live.
      gateInA = mountGateFor('/a/data.txt')
      releaseB()
    })
    const cmdB = runWithMountGate('/b', MountMode.WRITE, async () => {
      gateInB = mountGateFor('/b/y')
      releaseA()
      await holdB
    })
    await Promise.all([cmdA, cmdB])
    expect(gateInA).toEqual(['/a', MountMode.WRITE])
    expect(gateInB).toEqual(['/b', MountMode.WRITE])
    // Both runs settled, so both gates released.
    expect(mountGateFor('/a/data.txt')).toBeNull()
    expect(mountGateFor('/b/y')).toBeNull()
  })

  it('the longest covering prefix wins and a tie takes the weaker mode', async () => {
    await runWithMountGate('/repo', MountMode.WRITE, () =>
      runWithMountGate('/repo/sub', MountMode.READ, () => {
        // The way the mount table routes: the deeper mount serves the
        // deeper path.
        expect(mountGateFor('/repo/sub/x')).toEqual(['/repo/sub', MountMode.READ])
        expect(mountGateFor('/repo/y')).toEqual(['/repo', MountMode.WRITE])
        expect(mountGateFor('/elsewhere')).toBeNull()
        return Promise.resolve()
      }),
    )
    await runWithMountGate('/data', MountMode.WRITE, () =>
      runWithMountGate('/data', MountMode.READ, () => {
        // Two workspaces sharing a fallback runtime with one prefix:
        // the reader cannot tell whose gate this is, so it answers
        // with the weaker mode.
        expect(mountGateFor('/data/x')).toEqual(['/data', MountMode.READ])
        return Promise.resolve()
      }),
    )
  })

  it('a failed run still releases its gate', async () => {
    await expect(
      runWithMountGate('/a', MountMode.WRITE, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    expect(mountGateFor('/a/x')).toBeNull()
  })

  it('requireMountWritable answers for the named mount, not a concurrent one', async () => {
    const sess = new SessionState({
      sessionId: 'agent',
      mountModes: new Map([['/trello', MountMode.READ]]),
    })
    await runWithSession(sess, () =>
      runWithMountGate('/s3', MountMode.WRITE, () =>
        runWithMountGate('/trello', MountMode.WRITE, () => {
          // Both gates live: the id-addressed trello write is judged by
          // trello's own gate even with s3's writable one beside it.
          expect(() => {
            requireMountWritable('/trello')
          }).toThrow(/read-only/)
          requireMountWritable('/s3')
          return Promise.resolve()
        }),
      ),
    )
  })
})

describe('session predicates on the fallback storage', () => {
  it('a hide holds while a concurrent session shadows the newest frame', async () => {
    const hider = new SessionState({
      sessionId: 'hider',
      hiddenPaths: { paths: ['/repo/.env'] },
    })
    const other = new SessionState({ sessionId: 'other' })
    const [hold, release] = gate()
    let allowedBesideHider: boolean | undefined
    const long = runWithSession(hider, async () => {
      await hold
    })
    const short = runWithSession(other, () => {
      // The hider's frame is not the newest, but its hide must still
      // count: every live session is folded, most restrictive first.
      allowedBesideHider = pathAllowed('/repo/.env')
      release()
      return Promise.resolve()
    })
    await Promise.all([long, short])
    expect(allowedBesideHider).toBe(false)
    expect(pathAllowed('/repo/.env')).toBe(true)
  })

  it('a settle out of order cannot wipe a live hide into visibility', async () => {
    // The slot's worst failure: the first-bound run settles, restores
    // its saved (empty) slot, and the still-running hider's predicates
    // all read "no session", which fails open — the hidden path turns
    // visible mid-command.
    const hider = new SessionState({
      sessionId: 'hider',
      hiddenPaths: { paths: ['/repo/.env'] },
    })
    const other = new SessionState({ sessionId: 'other' })
    const [hold, release] = gate()
    let seen: boolean | undefined
    const first = runWithSession(other, async () => {
      await hold
    })
    const second = runWithSession(hider, async () => {
      release()
      await first
      seen = pathAllowed('/repo/.env')
    })
    await second
    expect(seen).toBe(false)
  })

  it('getCurrentSessionFor answers by owner while another workspace is live', async () => {
    const ownerA = {} as unknown as SessionManager
    const ownerB = {} as unknown as SessionManager
    const sessA = new SessionState({ sessionId: 'a' })
    const sessB = new SessionState({ sessionId: 'b' })
    const [hold, release] = gate()
    let forA: SessionState | null = null
    let forB: SessionState | null = null
    const runA = runWithSession(
      sessA,
      async () => {
        await hold
      },
      ownerA,
    )
    const runB = runWithSession(
      sessB,
      () => {
        // A's binding is beneath B's own: the owner search must reach
        // past the newest frame, where the slot read answered null.
        forA = getCurrentSessionFor(ownerA)
        forB = getCurrentSessionFor(ownerB)
        release()
        return Promise.resolve()
      },
      ownerB,
    )
    await Promise.all([runA, runB])
    expect(forA).toBe(sessA)
    expect(forB).toBe(sessB)
    expect(getCurrentSessionFor(ownerA)).toBeNull()
  })

  it('the umask ORs across live sessions, clearing toward the tighter mode', async () => {
    const loose = new SessionState({ sessionId: 'loose' })
    loose.umask = 0o022
    const tight = new SessionState({ sessionId: 'tight' })
    tight.umask = 0o077
    const [hold, release] = gate()
    let masked: number | undefined
    const long = runWithSession(tight, async () => {
      await hold
    })
    const short = runWithSession(loose, () => {
      masked = sessionUmask()
      release()
      return Promise.resolve()
    })
    await Promise.all([long, short])
    expect(masked).toBe(0o077)
  })
})

describe('the admission gate on the fallback storage', () => {
  const ruleShared = { reason: 'shared' } as unknown as CommandRule
  const ruleAOnly = { reason: 'a-only' } as unknown as CommandRule

  function entryGate(scoped: boolean, granted: readonly CommandRule[], refuse: string): EntryGate {
    return {
      scoped,
      granted,
      check(virtual: string): void {
        if (virtual === refuse) throw new Error(`refused: ${virtual}`)
      },
    }
  }

  it('two live gates merge toward refusal', async () => {
    const gateA = entryGate(true, [ruleShared, ruleAOnly], '/a/secret')
    const gateB = entryGate(false, [ruleShared], '/b/secret')
    const [hold, release] = gate()
    const runA = runWithAdmission(gateA, async () => {
      await hold
    })
    const runB = runWithAdmission(gateB, () => {
      const seen = getAdmission()
      release()
      return Promise.resolve(seen)
    })
    const [, merged] = await Promise.all([runA, runB])
    if (merged === null) throw new Error('no gate answered')
    const live: EntryGate = merged
    // An entry must pass every live gate, a walk scopes when any live
    // gate scopes, and a once-grant counts only when every live gate
    // carries it: a nod taken for one line must not authorize another.
    expect(() => {
      live.check('/a/secret')
    }).toThrow('refused: /a/secret')
    expect(() => {
      live.check('/b/secret')
    }).toThrow('refused: /b/secret')
    live.check('/fine')
    expect(live.scoped).toBe(true)
    expect(live.granted).toEqual([ruleShared])
    expect(getAdmission()).toBeNull()
  })

  it('a lone live gate answers as itself, and survives a concurrent settle', async () => {
    const gateA = entryGate(true, [ruleAOnly], '/a/secret')
    const gateB = entryGate(false, [], '/b/secret')
    const [hold, release] = gate()
    let after: EntryGate | null = null
    const first = runWithAdmission(gateB, async () => {
      await hold
    })
    const second = runWithAdmission(gateA, async () => {
      release()
      await first
      after = getAdmission()
    })
    await second
    expect(after).toBe(gateA)
  })
})

describe('op policies on the fallback storage', () => {
  const armed = { wants: () => true } as unknown as Policies

  it('an armed frame survives a concurrent settle', async () => {
    const [hold, release] = gate()
    let after: Policies | null = null
    const first = runWithOpPolicies({ wants: () => true } as unknown as Policies, async () => {
      await hold
    })
    const second = runWithOpPolicies(armed, async () => {
      release()
      await first
      after = getOpPolicies()
    })
    await second
    expect(after).toBe(armed)
  })

  it('a suspension yields to a concurrently armed frame, and stands alone otherwise', async () => {
    // Deliberate fallback divergence: with no execution identity, a
    // suspension that silenced every live frame would disarm a
    // concurrent command's op doors (failing open), so the delegated
    // sub-command double-admits instead (failing closed). A lone
    // suspension still answers null, which is the isolating behavior.
    const [hold, release] = gate()
    let besideArmed: Policies | null = null
    const long = runWithOpPolicies(armed, async () => {
      await hold
    })
    const short = runWithSuspendedOpPolicies(() => {
      besideArmed = getOpPolicies()
      release()
      return Promise.resolve()
    })
    await Promise.all([long, short])
    expect(besideArmed).toBe(armed)
    await runWithSuspendedOpPolicies(() => {
      expect(getOpPolicies()).toBeNull()
      return Promise.resolve()
    })
  })
})

describe('redirect targets on the fallback storage', () => {
  it('each statement finds its own targets by node while both are live', async () => {
    const nodeA = {}
    const nodeB = {}
    const outA = PathSpec.fromStrPath('/a/out.txt')
    const outB = PathSpec.fromStrPath('/b/out.txt')
    const [hold, release] = gate()
    let pathsInA: readonly PathSpec[] = []
    let judgedInA = false
    const runA = runWithRedirectPaths(nodeA, [outA], async () => {
      await hold
      pathsInA = redirectPathsFor(nodeA)
      judgedInA = redirectTargetJudged(outA.virtual)
    })
    const runB = runWithRedirectPaths(nodeB, [outB], () => {
      expect(redirectPathsFor(nodeB)).toEqual([outB])
      expect(redirectPathsFor(nodeA)).toEqual([outA])
      release()
      return Promise.resolve()
    })
    await Promise.all([runA, runB])
    expect(pathsInA).toEqual([outA])
    expect(judgedInA).toBe(true)
    expect(redirectTargetJudged(outA.virtual)).toBe(false)
    expect(redirectPathsFor(nodeA)).toEqual([])
  })
})

describe('a named facade session on the fallback storage', () => {
  it('is bound even while another task holds a wider session live', async () => {
    // The newest live frame here is whichever task bound last, not
    // this task's own, so a facade that names its session must not
    // take that frame for its ambient context: a wide session held
    // live by a concurrent task would otherwise judge the named
    // session's ops. The unnamed door keeps the ambient frame, which
    // is what a command's runtime reaching `ws.vfs` relies on.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.WRITE] as const },
      {
        mode: MountMode.WRITE,
        shellParser: parser,
        profiles: { agent: parseSessionProfile({ paths: { hide: ['/data/vault'] } }) },
        profile: 'agent',
      },
    )
    try {
      const host = ws.createSession('host', { profile: parseSessionProfile({}) })
      const wide = new Session(ws, host.sessionId).vfs
      await wide.mkdir('/data/vault')
      await wide.writeFile('/data/vault/secret', 'top\n')
      const [held, release] = gate()
      const holding = runWithSession(host, () => held, ws.sessionManager)
      const named = new Session(ws, ws.defaultSessionId).vfs
      await expect(named.readFile('/data/vault/secret')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await ws.vfs.readFileText('/data/vault/secret')).toBe('top\n')
      release()
      await holding
    } finally {
      await ws.close()
    }
  })
})
