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

import {
  EvaluationContext,
  getCurrentEvaluation,
  runWithEvaluation,
} from '../workspace/evaluation.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  captureSessionContext,
  getAdmission,
  getCurrentSessionFor,
  getCurrentSession,
  getOpPolicies,
  isProgramInvocation,
  mountGateFor,
  sessionVisibility,
  redirectPathsFor,
  redirectTargetJudged,
  requireMountWritable,
  runAsProgram,
  runWithAdmission,
  runWithMountGate,
  runWithOpPolicies,
  runWithRedirectPaths,
  runWithSession,
  sessionUmask,
} from './session_context.ts'
import { CLISpec } from '../commands/cli/types.ts'
import { IOResult, materialize } from '../io/types.ts'
import { handleXargs } from '../workspace/executor/builtins/xargs/xargs.ts'
import { seedVar, sessionView } from '../workspace/session/state.ts'
import type { EntryGate } from '../types.ts'
import { MountMode, PathSpec } from '../types.ts'
import type { CommandRule } from '../policy/types.ts'
import type { Policy } from '../policy/base.ts'
import type { Policies } from '../policy/policies.ts'
import type { SessionManager } from '../workspace/session/manager.ts'
import { SessionState } from '../workspace/session/session.ts'
import { parseSessionProfile } from '../policy/profile.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import { Session } from '../workspace/workspace/handle.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'
import type * as asyncContextModule from '../utils/async_context.ts'
import { ContextScope } from '../utils/context_scope.ts'
import { pathVisible } from '../utils/hidden.ts'
import { MountRegistry } from '../workspace/mount/registry.ts'
import { namespaceViewOf } from '../workspace/mount/namespace/view.ts'
import type { DispatchFn } from '../runtime/types.ts'

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
      visibility: { paths: { paths: ['/repo/.env'] } },
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
      allowedBesideHider = pathVisible(sessionVisibility(), '/repo/.env')
      release()
      return Promise.resolve()
    })
    await Promise.all([long, short])
    expect(allowedBesideHider).toBe(false)
    expect(pathVisible(sessionVisibility(), '/repo/.env')).toBe(true)
  })

  it('folds every live visibility toward the narrower view', async () => {
    // Two sessions live on the one slot: a hide or a hidden var of
    // either holds, a show holds only where every hider shows it (at any
    // mode: the mode gates read each session's own), and the wider
    // process scope and command list need both to agree.
    const wide = new SessionState({
      sessionId: 'wide',
      visibility: {
        paths: { paths: ['/a'] },
        shown: {
          entries: [
            { path: '/a/ok', mode: null },
            { path: '/b/ok', mode: MountMode.READ },
          ],
        },
        vars: { names: ['A'] },
        processes: 'workspace',
        commands: ['ls', 'cat'],
      },
    })
    const narrow = new SessionState({
      sessionId: 'narrow',
      visibility: {
        paths: { paths: ['/b'] },
        shown: { entries: [{ path: '/b/ok', mode: MountMode.WRITE }] },
        vars: { patterns: ['X_*'] },
        processes: 'session',
        commands: ['cat', 'rm'],
      },
    })
    const [hold, release] = gate()
    let seen: ReturnType<typeof sessionVisibility> = null
    const long = runWithSession(wide, async () => {
      await hold
    })
    const short = runWithSession(narrow, () => {
      seen = sessionVisibility()
      release()
      return Promise.resolve()
    })
    await Promise.all([long, short])
    expect(seen).toEqual({
      paths: { paths: ['/a', '/b'], patterns: [] },
      shown: { entries: [{ path: '/b/ok', mode: MountMode.READ }] },
      vars: { names: ['A'], patterns: ['X_*'] },
      processes: 'session',
      commands: ['cat'],
    })
  })

  it('a command view folds the live sessions as the op door does', async () => {
    const hider = new SessionState({
      sessionId: 'hider',
      visibility: { paths: { paths: ['/data/x'] } },
    })
    const other = new SessionState({ sessionId: 'other' })
    const registry = new MountRegistry({ '/data': new RAMVFS() }, MountMode.WRITE)
    const dispatch = (() => Promise.reject(new Error('unused'))) as unknown as DispatchFn
    const [hold, release] = gate()
    let folded: boolean | undefined
    const long = runWithSession(hider, async () => {
      await hold
    })
    const short = runWithSession(other, () => {
      const vis = namespaceViewOf(registry, null, dispatch, other).visibility ?? null
      folded = pathVisible(vis, '/data/x')
      release()
      return Promise.resolve()
    })
    await Promise.all([long, short])
    expect(folded).toBe(false)
    // A session named outside any line keeps its own view.
    const own = namespaceViewOf(registry, null, dispatch, other).visibility ?? null
    expect(pathVisible(own, '/data/x')).toBe(true)
  })

  it('a settle out of order cannot wipe a live hide into visibility', async () => {
    // The slot's worst failure: the first-bound run settles, restores
    // its saved (empty) slot, and the still-running hider's predicates
    // all read "no session", which fails open — the hidden path turns
    // visible mid-command.
    const hider = new SessionState({
      sessionId: 'hider',
      visibility: { paths: { paths: ['/repo/.env'] } },
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
      seen = pathVisible(sessionVisibility(), '/repo/.env')
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
      { owner: ownerA },
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
      { owner: ownerB },
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
      scopes: () => scoped,
      granted,
      check(virtual: string): void {
        if (virtual === refuse) throw new Error(`refused: ${virtual}`)
      },
      refuses(virtual: string): boolean {
        return virtual === refuse
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
    expect([live.refuses('/a/secret'), live.refuses('/b/secret'), live.refuses('/fine')]).toEqual([
      true,
      true,
      false,
    ])
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
      await wide.write('/data/vault/secret', 'top\n')
      const [held, release] = gate()
      const holding = runWithSession(host, () => held, { owner: ws.sessionManager })
      const named = new Session(ws, ws.defaultSessionId).vfs
      await expect(named.read('/data/vault/secret')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await ws.vfs.cat('/data/vault/secret')).toBe('top\n')
      release()
      await holding
    } finally {
      await ws.close()
    }
  })
})

describe('dry runs on the fallback storage', () => {
  it('refuse explain.vfs and leave a concurrent write alone', async () => {
    // Without task isolation a dry run's binding would sit on top of the
    // frame stack for every concurrent task: a real op would be stopped
    // as explained, or refused as a deciding policy's write.
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.WRITE] as const },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const session = new Session(ws, ws.defaultSessionId)
      await expect(session.explain.vfs.read('/data/x')).rejects.toThrow(/isolates async tasks/)
      const [held, release] = gate()
      const [deciding, decided] = gate()
      const waits: Policy = {
        async preCommand(): Promise<null> {
          decided()
          await held
          return null
        },
      }
      ws.policies.add(waits)
      const explained = session.explain.shell('ls /data')
      await deciding
      await ws.vfs.write('/data/y', 'y')
      release()
      await explained
      expect(await ws.vfs.cat('/data/y')).toBe('y')
    } finally {
      await ws.close()
    }
  })
})

describe('deferred evaluation on the fallback storage', () => {
  it.each([false, true])(
    'restores a deferred evaluator with explicit session %s',
    async (explicit) => {
      const parent = new EvaluationContext(new SessionState({ sessionId: 'parent' }))
      const child = parent.fork()
      const deferred = await runAsProgram(parent.session, () =>
        runWithEvaluation(child, () =>
          Promise.resolve(
            new ContextScope(captureSessionContext(explicit ? child.session : undefined)),
          ),
        ),
      )
      const other = new EvaluationContext(new SessionState({ sessionId: 'other' }))
      await runWithEvaluation(other, async () => {
        const recaptured = await deferred.run(async () => {
          await Promise.resolve()
          expect(getCurrentSession()).toBe(child.session)
          expect(getCurrentEvaluation()).toBe(child)
          expect(isProgramInvocation(child.session)).toBe(true)
          return new ContextScope(captureSessionContext())
        })
        await recaptured.run(async () => {
          await Promise.resolve()
          expect(getCurrentEvaluation()).toBe(child)
          expect(isProgramInvocation(child.session)).toBe(true)
        })
        expect(getCurrentEvaluation()).toBe(other)
        expect(getCurrentSession()).toBe(other.session)
      })
      expect(getCurrentEvaluation()).toBeNull()
      expect(getCurrentSession()).toBeNull()
    },
  )
})

describe('xargs session isolation on the fallback storage', () => {
  it.each<[number, string]>([
    [0, 'a'],
    [0, 'a b'],
    [2, 'a'],
    [2, 'a b'],
  ])('-P%i forks each invocation for %s while serializing execution', async (procs, data) => {
    const parent = new SessionState({ sessionId: 'xargs' })
    seedVar(parent, 'X', 'outer')
    const seen: string[] = []
    let active = 0
    let peak = 0
    const execute = async (line: string): Promise<IOResult> => {
      const current = getCurrentSession()
      if (current === null) throw new Error('missing session')
      seen.push(current.env.X ?? '')
      active += 1
      peak = Math.max(peak, active)
      await sessionView(current).set('X', line)
      await Promise.resolve()
      active -= 1
      async function* stream(kind: string) {
        await Promise.resolve()
        expect(getCurrentSession()).toBe(current)
        yield new TextEncoder().encode(`${kind}:${getCurrentSession()?.env.X ?? ''}\n`)
      }
      return new IOResult({ stdout: stream('out'), stderr: stream('err') })
    }
    await runWithSession(parent, async () => {
      const [out, io] = await handleXargs(
        execute,
        [`-P${String(procs)}`, '-n1', 'echo'],
        new EvaluationContext(parent),
        new TextEncoder().encode(data),
      )
      expect(getCurrentSession()).toBe(parent)
      expect(new TextDecoder().decode(await materialize(out))).toBe(
        data
          .split(' ')
          .map((word) => `out:echo ${word}\n`)
          .join(''),
      )
      expect(new TextDecoder().decode(await materialize(io.stderr))).toBe(
        data
          .split(' ')
          .map((word) => `err:echo ${word}\n`)
          .join(''),
      )
      expect(io.exitCode).toBe(0)
    })
    expect(seen).toEqual(data.split(' ').map(() => 'outer'))
    expect(peak).toBe(1)
    expect(parent.env.X).toBe('outer')
    expect(getCurrentSession()).toBeNull()
  })

  it('restores the parent when a single invocation throws', async () => {
    const parent = new SessionState({ sessionId: 'xargs' })
    seedVar(parent, 'X', 'outer')
    const execute = async (): Promise<IOResult> => {
      const current = getCurrentSession()
      if (current === null) throw new Error('missing session')
      await sessionView(current).set('X', 'inner')
      throw new Error('command failed')
    }
    await runWithSession(parent, async () => {
      await expect(
        handleXargs(
          execute,
          ['-P2', 'echo'],
          new EvaluationContext(parent),
          new TextEncoder().encode('a'),
        ),
      ).rejects.toThrow('command failed')
      expect(getCurrentSession()).toBe(parent)
      expect(parent.env.X).toBe('outer')
    })
    expect(getCurrentSession()).toBeNull()
  })

  it.each([0, 2])('-P%i keeps shell variables local to each invocation', async (procs) => {
    const parser = await getTestParser()
    const ws = new Workspace({}, { shellParser: parser })
    try {
      const io = await ws.shell(
        `X=outer; change() { echo "$X"; X=inner; }; printf 'a\\nb\\n' | xargs -P${String(procs)} -n1 change; echo "$X"`,
      )
      expect(new TextDecoder().decode(io.stdout)).toBe('outer\nouter\nouter\n')
      expect(new TextDecoder().decode(io.stderr)).toBe('')
      expect(io.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })
})

describe('overlapping shell calls beside xargs', () => {
  it('keeps another foreground call queued and honors its abort', async () => {
    const parser = await getTestParser()
    const ws = new Workspace({}, { shellParser: parser })
    const child = ws.shell('printf a | xargs -P2 -I{} sleep 0.3')
    try {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await expect(
        ws.shell('Y=leaked', {
          sessionId: ws.defaultSessionId,
          signal: AbortSignal.timeout(100),
        }),
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await child
      expect(ws.getSession(ws.defaultSessionId).env.Y).toBeUndefined()
      await ws.close()
    }
  })

  it.each(['again', 'printf a | xargs -P2 -I{} again', 'again | cat'])(
    'lets a host callback re-enter its own session: %s',
    async (line) => {
      const parser = await getTestParser()
      const ws = new Workspace({}, { shellParser: parser })
      ws.registerCli(
        'again',
        new CLISpec({
          name: 'again',
          fn: async (inv) => {
            await Promise.resolve()
            if (inv.shell === undefined) throw new Error('missing invocation shell')
            const inner = await inv.shell('Z=inner; echo inner')
            return [inner.stdout, inner]
          },
        }),
      )
      try {
        const io = await ws.shell(line)
        expect(io.stdoutText).toBe('inner\n')
        expect(ws.getSession(ws.defaultSessionId).env.Z).toBe(
          line === 'again' ? 'inner' : undefined,
        )
      } finally {
        await ws.close()
      }
    },
  )

  it.each([false, true])(
    'queues unrelated calls while a callback re-enters (named=%s)',
    async (named) => {
      const parser = await getTestParser()
      const ws = new Workspace({}, { shellParser: parser })
      const [entered, enter] = gate()
      const [held, release] = gate()
      let expired: ((command: string) => Promise<IOResult>) | undefined
      ws.registerCli(
        'again',
        new CLISpec({
          name: 'again',
          fn: async (inv) => {
            expired = inv.shell
            enter()
            await held
            if (inv.shell === undefined) throw new Error('missing invocation shell')
            const inner = await inv.shell('X=inner; echo "$X"')
            return [inner.stdout, inner]
          },
        }),
      )
      try {
        const outer = ws.shell('X=outer; again; echo "$X"')
        await entered
        let finished = false
        const unrelated = ws
          .shell('echo "$X"; X=other', named ? { sessionId: ws.defaultSessionId } : {})
          .then((result) => {
            finished = true
            return result
          })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(finished).toBe(false)
        await expect(
          ws.shell('X=leaked', { signal: AbortSignal.timeout(20) }),
        ).rejects.toMatchObject({ name: 'AbortError' })
        release()
        expect((await outer).stdoutText).toBe('inner\ninner\n')
        expect((await unrelated).stdoutText).toBe('inner\n')
        expect(ws.getSession(ws.defaultSessionId).env.X).toBe('other')
        if (expired === undefined) throw new Error('missing saved shell')
        await expect(expired('X=leaked')).rejects.toThrow('no longer active')
        expect(ws.getSession(ws.defaultSessionId).env.X).toBe('other')
      } finally {
        release()
        await ws.close()
      }
    },
  )

  it('admits nothing through a host callback of a line that has ended', async () => {
    const parser = await getTestParser()
    const ws = new Workspace({}, { shellParser: parser })
    const [entered, enter] = gate()
    const [held, release] = gate()
    ws.registerCli(
      'hold',
      new CLISpec({
        name: 'hold',
        fn: async () => {
          enter()
          await held
          return [null, new IOResult()]
        },
      }),
    )
    try {
      await ws.shell('hold &')
      await entered
      const running = ws.shell('sleep 0.3')
      await new Promise((resolve) => setTimeout(resolve, 20))
      await expect(
        ws.shell('Y=leaked', { signal: AbortSignal.timeout(100) }),
      ).rejects.toMatchObject({ name: 'AbortError' })
      await running
      expect(ws.getSession(ws.defaultSessionId).env.Y).toBeUndefined()
    } finally {
      release()
      await ws.jobTable.wait(1, ws.defaultSessionId)
      await ws.close()
    }
  })

  it.each(
    [0, 2].flatMap((procs) =>
      [false, true].flatMap((named) =>
        [false, true].map((childFirst) => ({ procs, named, childFirst })),
      ),
    ),
  )('keeps sessions separate: %j', async ({ procs, named, childFirst }) => {
    const parser = await getTestParser()
    const ws = new Workspace({}, { shellParser: parser })
    const [childEntered, enterChild] = gate()
    const [childHeld, releaseChild] = gate()
    const [otherEntered, enterOther] = gate()
    const [otherHeld, releaseOther] = gate()
    ws.registerCli(
      'holdchild',
      new CLISpec({
        name: 'holdchild',
        fn: async () => {
          enterChild()
          await childHeld
          return [null, new IOResult()]
        },
      }),
    )
    ws.registerCli(
      'holdother',
      new CLISpec({
        name: 'holdother',
        fn: async () => {
          enterOther()
          await otherHeld
          return [null, new IOResult()]
        },
      }),
    )
    try {
      await ws.shell('X=outer; child() { holdchild; eval "X=child"; echo "$X"; }')
      await ws.shell(`printf a | xargs -P${String(procs)} -I{} child &`)
      const child = ws.jobTable.wait(1, ws.defaultSessionId)
      await childEntered
      const other = ws.shell(
        'holdother; eval "Y=kept"; echo "$X:$Y"',
        named ? { sessionId: ws.defaultSessionId } : {},
      )
      await otherEntered
      if (childFirst) {
        releaseChild()
        await child
        releaseOther()
      } else {
        releaseOther()
        await other
        releaseChild()
      }
      const [childResult, otherResult] = await Promise.all([child, other])
      expect(new TextDecoder().decode(await childResult.console.snapshot())).toBe('child\n')
      // The job's output reaches the terminal as it is written: the line
      // running then shows it, or else the next one does.
      expect(otherResult.stdoutText).toBe(childFirst ? 'child\nouter:kept\n' : 'outer:kept\n')
      expect(childResult.exitCode).toBe(0)
      expect(otherResult.exitCode).toBe(0)
      expect((await ws.shell('echo "$X:$Y"')).stdoutText).toBe(
        childFirst ? 'outer:kept\n' : 'child\nouter:kept\n',
      )
    } finally {
      releaseChild()
      releaseOther()
      await ws.close()
    }
  })
})
