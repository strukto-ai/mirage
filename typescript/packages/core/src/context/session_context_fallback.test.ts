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
import { expandPattern, resolveGlobWith } from '../utils/glob_walk.ts'
import { newStatusWriter, runWithLineAbort } from '../workspace/abort.ts'
import { CommandSpec } from '../commands/spec/types.ts'
import { CLIHandler } from '../commands/cli/types.ts'

import { EvaluationContext } from '../workspace/evaluation.ts'
import { describe, expect, it, vi } from 'vitest'
import {
  sessionCaller,
  getAdmission,
  getCurrentSessionFor,
  getCurrentSession,
  isProgramInvocation,
  sessionVisibility,
  redirectPathsFor,
  redirectTargetJudged,
  runAsProgram,
  runWithAdmission,
  runWithRedirectPaths,
  runWithSession,
  sessionUmask,
  getCurrentEvaluation,
  runWithEvaluation,
  currentCaller,
  runWithCaller,
} from './session_context.ts'
import { CLI } from '../commands/cli/types.ts'
import { IOResult, materialize } from '../io/types.ts'
import { handleXargs as streamXargs } from '../workspace/executor/builtins/xargs/xargs.ts'
import { seedVar, sessionView } from '../workspace/session/state.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../types.ts'
import { searchScope } from '../core/slug_tree/search.ts'
import { SlugTree } from '../core/slug_tree/tree.ts'
import {
  type Action,
  type CommandRule,
  type Decision,
  type EntryGate,
  Outcome,
  Scope,
} from '../policy/types.ts'
import type { Policy } from '../policy/base.ts'
import type { SessionManager } from '../workspace/session/manager.ts'
import { SessionState } from '../workspace/session/session.ts'
import { parseSessionProfile } from '../policy/profile.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { getTestParser } from '../../tests/workspace/fixtures/workspace_fixture.ts'
import { Session, Workspace } from '../workspace/workspace/workspace.ts'
import type * as asyncContextModule from '../utils/async_context.ts'
import { pathVisible } from '../utils/hidden.ts'
import { Files, readerOf } from '../workspace/files.ts'
import { readers } from '../test-utils.ts'
import type { DispatchFn } from '../runtime/types.ts'
import type { Handed } from '../vfs/types.ts'

const DEC = new TextDecoder()

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

async function handleXargs(
  ...args: Parameters<typeof streamXargs>
): ReturnType<typeof streamXargs> {
  const [out, io, node] = await streamXargs(...args)
  return [await materialize(out), io, node]
}

describe('the bound evaluation on the fallback storage', () => {
  it('a bind without an evaluation does not hide a running line', async () => {
    // A line waits (its write's turn) while a held dispatcher binds another
    // session with no evaluation: that frame is the newest, and must not
    // answer the line with none, or its abort check is skipped.
    const line = new SessionState({ sessionId: 'line', cwd: '/' })
    const other = new SessionState({ sessionId: 'other', cwd: '/' })
    const evaluation = new EvaluationContext(line)
    const [holdLine, releaseLine] = gate()
    const [holdGate, releaseGate] = gate()
    let seen: EvaluationContext | null = null
    const running = runWithEvaluation(evaluation, async () => {
      await holdLine
      seen = getCurrentEvaluation()
      releaseGate()
    })
    const entered = runWithSession(other, async () => {
      releaseLine()
      await holdGate
    })
    await Promise.all([running, entered])
    expect(seen).toBe(evaluation)
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

  it('a command view keeps the named session while another session is live', async () => {
    const hider = new SessionState({
      sessionId: 'hider',
      visibility: { paths: { paths: ['/data/x'] } },
    })
    const other = new SessionState({ sessionId: 'other' })
    const dispatch = (() => Promise.reject(new Error('unused'))) as unknown as DispatchFn
    const [hold, release] = gate()
    let folded: boolean | undefined
    const long = runWithSession(hider, async () => {
      await hold
    })
    const short = runWithSession(other, () => {
      folded = readerOf(new Files(dispatch, readers([], null, other.visibility))).visible('/data/x')
      release()
      return Promise.resolve()
    })
    await Promise.all([long, short])
    expect(folded).toBe(true)
    // A session named outside any line keeps its own view.
    const own = readerOf(new Files(dispatch, readers([], null, other.visibility)))
    expect(own.visible('/data/x')).toBe(true)
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
      refusal: (virtual: string): string | null => (virtual === refuse ? 'refused' : null),
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
    expect(live.refusal('/b/secret')).toBe('refused')
    expect(live.refusal('/fine')).toBeNull()
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
    // session's ops. The unnamed entry point keeps the ambient frame, which
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
      expect(DEC.decode(await ws.vfs.read('/data/vault/secret'))).toBe('top\n')
      release()
      await holding
    } finally {
      await ws.close()
    }
  })
})

describe('dry runs on the fallback storage', () => {
  it('explain a vfs call and leave a concurrent write alone', async () => {
    // The dry run rides its own call, not the frame stack: a real op
    // another task makes meanwhile runs for real.
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.WRITE] as const },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const session = new Session(ws, ws.defaultSessionId)
      const [reading, read] = gate()
      const [asking, asked] = gate()
      ws.policies.add({
        async preVfs(ctx): Promise<Action | null> {
          if (ctx.path.virtual !== '/data/x') return null
          asked()
          await reading
          return { kind: 'deny', reason: 'x is sealed' }
        },
      })
      const dry = session.explain.vfs.read('/data/x')
      await asking
      await ws.vfs.write('/data/z', 'z')
      read()
      expect(await dry).toMatchObject({ outcome: Outcome.DENY, reason: 'x is sealed' })
      expect(DEC.decode(await ws.vfs.read('/data/z'))).toBe('z')
    } finally {
      await ws.close()
    }
  })

  it('explain a line and leave a concurrent write alone', async () => {
    // Without task isolation a dry run's binding would sit on top of the
    // frame stack for every concurrent task: a real op would be stopped
    // as explained, or refused as a deciding policy's write.
    const ws = new Workspace(
      { '/data': [new RAMVFS(), MountMode.WRITE] as const },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    try {
      const session = new Session(ws, ws.defaultSessionId)
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
      expect(DEC.decode(await ws.vfs.read('/data/y'))).toBe('y')
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
          Promise.resolve(explicit ? sessionCaller(child.session) : currentCaller()),
        ),
      )
      const other = new EvaluationContext(new SessionState({ sessionId: 'other' }))
      await runWithEvaluation(other, async () => {
        const recaptured = await runWithCaller(deferred, async () => {
          await Promise.resolve()
          expect(getCurrentSession()).toBe(child.session)
          expect(getCurrentEvaluation()).toBe(child)
          expect(isProgramInvocation(child.session)).toBe(true)
          return currentCaller()
        })
        await runWithCaller(recaptured, async () => {
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
        new CLI({
          spec: new CommandSpec({ name: 'again' }),
          handlers: {
            '': new CLIHandler({
              fn: async (_config, _paths, _texts, ctx) => {
                await Promise.resolve()
                if (ctx.shell === undefined) throw new Error('missing invocation shell')
                const inner = await ctx.shell('Z=inner; echo inner')
                return [inner.stdout, inner]
              },
            }),
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
        new CLI({
          spec: new CommandSpec({ name: 'again' }),
          handlers: {
            '': new CLIHandler({
              fn: async (_config, _paths, _texts, ctx) => {
                expired = ctx.shell
                enter()
                await held
                if (ctx.shell === undefined) throw new Error('missing invocation shell')
                const inner = await ctx.shell('X=inner; echo "$X"')
                return [inner.stdout, inner]
              },
            }),
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
      new CLI({
        spec: new CommandSpec({ name: 'hold' }),
        handlers: {
          '': new CLIHandler({
            fn: async () => {
              enter()
              await held
              return [null, new IOResult()]
            },
          }),
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
      new CLI({
        spec: new CommandSpec({ name: 'holdchild' }),
        handlers: {
          '': new CLIHandler({
            fn: async () => {
              enterChild()
              await childHeld
              return [null, new IOResult()]
            },
          }),
        },
      }),
    )
    ws.registerCli(
      'holdother',
      new CLI({
        spec: new CommandSpec({ name: 'holdother' }),
        handlers: {
          '': new CLIHandler({
            fn: async () => {
              enterOther()
              await otherHeld
              return [null, new IOResult()]
            },
          }),
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

it('keeps each browser session’s permissions, umask and glob settings across suspension', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const loose = ws.createSession('loose')
  const tight = ws.createSession('tight', {
    profile: parseSessionProfile({ mounts: { '/data': 'r' }, paths: { hide: ['/data/private'] } }),
  })
  loose.umask = 0o022
  loose.shopts.dotglob = true
  loose.shopts.extglob = true
  tight.umask = 0o077
  const [looseHeld, releaseLoose] = gate()
  const [tightHeld, releaseTight] = gate()
  const [bothEntered, enterBoth] = gate()
  let entered = 0
  ws.registerCli(
    'pause',
    new CLI({
      spec: new CommandSpec({ name: 'pause' }),
      handlers: {
        '': new CLIHandler({
          fn: async (_config, _paths, _texts, ctx) => {
            entered += 1
            if (entered === 2) enterBoth()
            await (ctx.env?.LABEL === 'loose' ? looseHeld : tightHeld)
            return [null, new IOResult()]
          },
        }),
      },
    }),
  )
  try {
    for (const name of ['a', 'b', '.hidden', 'private']) await ws.vfs.write(`/data/${name}`, name)
    const wide = ws.shell(
      'pause; mkdir /data/new; stat -c %a /data/new; echo /data/*; echo /data/@(a|b); p="/data/@(a|b)"; echo hi > $p',
      { sessionId: loose.sessionId, env: { LABEL: 'loose' } },
    )
    const narrow = ws.shell('pause; echo /data/*; mkdir /data/denied', {
      sessionId: tight.sessionId,
    })
    await bothEntered
    releaseLoose()
    const output = await wide
    releaseTight()
    const denied = await narrow
    expect(output.exitCode).toBe(1)
    expect(output.stderrText).toContain('ambiguous redirect')
    expect(output.stdoutText).toBe(
      '755\n/data/.hidden /data/a /data/b /data/new /data/private\n/data/a /data/b\n',
    )
    expect(denied.stdoutText).toBe('/data/a /data/b /data/new\n')
    expect(denied.exitCode).toBe(1)
    expect(denied.stderrText).toContain('Read-only file system')
  } finally {
    releaseLoose()
    releaseTight()
    await ws.close()
  }
})

it('keeps unbound file calls restrictive when a wider browser session shadows their owner', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const narrow = ws.createSession('narrow', {
    profile: parseSessionProfile({ mounts: { '/data': 'r' }, paths: { hide: ['/data/secret'] } }),
  })
  const wide = ws.createSession('wide')
  const [resume, releaseNarrow] = gate()
  const [held, releaseWide] = gate()
  try {
    await ws.vfs.write('/data/secret', 'secret')
    const first = runWithSession(
      narrow,
      async () => {
        await resume
        await expect(ws.vfs.read('/data/secret')).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(ws.vfs.write('/data/new', 'denied')).rejects.toMatchObject({ code: 'EROFS' })
      },
      { owner: ws.sessionManager },
    )
    const second = runWithSession(wide, () => held, { owner: ws.sessionManager })
    try {
      releaseNarrow()
      await first
    } finally {
      releaseWide()
      await second
    }
  } finally {
    releaseNarrow()
    releaseWide()
    await ws.close()
  }
})

it('walks a nested mount under the command’s own gate while another session’s gate is live', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS(), '/data/sub': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const sealed = ws.createSession('sealed', {
    profile: parseSessionProfile({
      commands: { deny: [{ reason: 'sealed', commands: { pause: ['/data/sub/box'] } }] },
    }),
  })
  const free = ws.createSession('free')
  const [held, release] = gate()
  const [entered, enter] = gate()
  ws.registerCli(
    'pause',
    new CLI({
      spec: new CommandSpec({ name: 'pause' }),
      handlers: {
        '': new CLIHandler({
          fn: async () => {
            enter()
            await held
            return [null, new IOResult()]
          },
        }),
      },
    }),
  )
  try {
    await ws.vfs.write('/data/a', 'a')
    await ws.vfs.mkdir('/data/sub/box')
    await ws.vfs.write('/data/sub/box/f', 'f')
    const paused = ws.shell('pause', { sessionId: sealed.sessionId })
    await entered
    const found = await ws.shell('find /data', { sessionId: free.sessionId })
    const grepped = await ws.shell('grep -r f /data', { sessionId: free.sessionId })
    release()
    await paused
    expect([found.stdoutText, found.stderrText, found.exitCode]).toEqual([
      '/data\n/data/a\n/data/sub\n/data/sub/box\n/data/sub/box/f\n',
      '',
      0,
    ])
    expect([grepped.stdoutText, grepped.stderrText, grepped.exitCode]).toEqual([
      '/data/sub/box/f:f\n',
      '',
      0,
    ])
  } finally {
    release()
    await ws.close()
  }
})

it('walks dotted operands with the command’s own probe while another session runs on the mount', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const wide = ws.createSession('wide')
  const hider = ws.createSession('hider', {
    profile: parseSessionProfile({ paths: { hide: ['/data/h'] } }),
  })
  const [held, release] = gate()
  const [started, start] = gate()
  async function* slow(): AsyncIterable<Uint8Array> {
    start()
    await held
    yield new TextEncoder().encode('done\n')
  }
  try {
    await ws.vfs.mkdir('/data/h')
    await ws.vfs.write('/data/h/x', 'x')
    await ws.vfs.write('/data/f', 'f')
    const line = 'stat -c %n /data/h/..; ls -d /data/h/..; cat /data/h/../f'
    const alone = await ws.shell(line, { sessionId: hider.sessionId })
    const reading = ws.shell('cat', { sessionId: wide.sessionId, cwd: '/data', stdin: slow() })
    await started
    const overlapped = await ws.shell(line, { sessionId: hider.sessionId })
    release()
    expect((await reading).stdoutText).toBe('done\n')
    expect([overlapped.exitCode, overlapped.stdoutText, overlapped.stderrText]).toEqual([
      alone.exitCode,
      alone.stdoutText,
      alone.stderrText,
    ])
    expect(alone.stdoutText).toBe('')
  } finally {
    release()
    await ws.close()
  }
})

it('links under the command’s own hides while another session’s hides are live', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const hider = ws.createSession('hider', {
    profile: parseSessionProfile({ paths: { hide: ['/data/x'] } }),
  })
  const wide = ws.createSession('wide')
  const [held, release] = gate()
  const [entered, enter] = gate()
  ws.registerCli(
    'pause',
    new CLI({
      spec: new CommandSpec({ name: 'pause' }),
      handlers: {
        '': new CLIHandler({
          fn: async () => {
            enter()
            await held
            return [null, new IOResult()]
          },
        }),
      },
    }),
  )
  try {
    await ws.shell('mkdir -p /data/x; echo t > /data/target; ln -s /data/target /data/x/link', {
      sessionId: wide.sessionId,
    })
    const line = (name: string): string =>
      `ln /data/x/link /data/${name}; readlink /data/${name}; echo rc=$?`
    const alone = await ws.shell(line('h1'), { sessionId: wide.sessionId })
    const paused = ws.shell('pause', { sessionId: hider.sessionId })
    await entered
    const overlapped = await ws.shell(line('h2'), { sessionId: wide.sessionId })
    release()
    await paused
    expect([alone.stdoutText, alone.stderrText]).toEqual(['/data/target\nrc=0\n', ''])
    expect([overlapped.stdoutText, overlapped.stderrText]).toEqual([alone.stdoutText, ''])
  } finally {
    release()
    await ws.close()
  }
})

/** A `pause` CLI each session's line enters and holds until released. */
function registerPauses(ws: Workspace): Map<string, [Promise<void>, () => void, Promise<void>]> {
  const holds = new Map<string, [Promise<void>, () => void, Promise<void>]>()
  const entries = new Map<string, () => void>()
  for (const who of ['a', 'b']) {
    const [held, release] = gate()
    const [entered, enter] = gate()
    holds.set(who, [held, release, entered])
    entries.set(who, enter)
  }
  ws.registerCli(
    'pause',
    new CLI({
      spec: new CommandSpec({ name: 'pause' }),
      handlers: {
        '': new CLIHandler({
          fn: async (_config, _paths, _texts, ctx) => {
            const who = ctx.env?.WHO ?? 'b'
            entries.get(who)?.()
            await holds.get(who)?.[0]
            return [null, new IOResult()]
          },
        }),
      },
    }),
  )
  return holds
}

describe('a line beside another session’s paused line on the fallback storage', () => {
  it('keeps a once-granted ask path for the command it was granted to', async () => {
    const allowOnce = (asked: Decision): Promise<Decision> =>
      Promise.resolve({ ...asked, outcome: Outcome.ALLOW, scope: Scope.ONCE })
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser(), onAsk: allowOnce },
    )
    const asker = ws.createSession('asker', {
      profile: parseSessionProfile({
        commands: { ask: [{ reason: 'review', paths: ['/data/review/*'] }] },
      }),
    })
    const other = ws.createSession('other')
    const holds = registerPauses(ws)
    try {
      await ws.vfs.mkdir('/data/review')
      await ws.vfs.write('/data/review/f', 'reviewed\n')
      await ws.vfs.mkdir('/data/review/sub')
      await ws.vfs.write('/data/review/sub/x', 'x')
      const line = 'cat /data/review/f; ls /data/review/sub'
      const alone = await ws.shell(line, { sessionId: asker.sessionId })
      const paused = ws.shell('pause', { sessionId: other.sessionId })
      await holds.get('b')?.[2]
      const overlapped = await ws.shell(line, { sessionId: asker.sessionId })
      holds.get('b')?.[1]()
      await paused
      expect([alone.exitCode, alone.stdoutText]).toEqual([0, 'reviewed\nx\n'])
      expect([overlapped.exitCode, overlapped.stdoutText, overlapped.stderrText]).toEqual([
        0,
        'reviewed\nx\n',
        '',
      ])
    } finally {
      for (const [, release] of holds.values()) release()
      await ws.close()
    }
  })

  it('reports the session’s own mount mode', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    const narrow = ws.createSession('narrow', {
      profile: parseSessionProfile({ mounts: { '/data': 'r' } }),
    })
    const wide = ws.createSession('wide')
    const holds = registerPauses(ws)
    try {
      const alone = await ws.shell('mount -t ram', { sessionId: wide.sessionId })
      const paused = ws.shell('pause', { sessionId: narrow.sessionId })
      await holds.get('b')?.[2]
      const overlapped = await ws.shell('mount -t ram', { sessionId: wide.sessionId })
      holds.get('b')?.[1]()
      await paused
      expect(alone.stdoutText).toContain('on /data type ram (rw')
      expect(overlapped.stdoutText).toBe(alone.stdoutText)
    } finally {
      for (const [, release] of holds.values()) release()
      await ws.close()
    }
  })

  it('runs find -exec as find’s own session', async () => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.WRITE, shellParser: await getTestParser() },
    )
    const a = ws.createSession('a')
    const b = ws.createSession('b')
    const holds = registerPauses(ws)
    try {
      await ws.vfs.write('/data/f', 'f')
      const line = 'find /data -name f -exec printf -v x %s {} + ; echo'
      const alone = await ws.shell(line, { sessionId: a.sessionId })
      const first = ws.shell(`pause; ${line}`, { sessionId: a.sessionId, env: { WHO: 'a' } })
      await holds.get('a')?.[2]
      const second = ws.shell('pause', { sessionId: b.sessionId, env: { WHO: 'b' } })
      await holds.get('b')?.[2]
      holds.get('a')?.[1]()
      const overlapped = await first
      holds.get('b')?.[1]()
      await second
      expect(alone.stdoutText).toBe('-v\n')
      expect([overlapped.stdoutText, overlapped.stderrText]).toEqual([
        alone.stdoutText,
        alone.stderrText,
      ])
    } finally {
      for (const [, release] of holds.values()) release()
      await ws.close()
    }
  })
})

it('judges a named facade’s op by its own rules when a wider session binds meanwhile', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  ws.createSession('sealed', {
    profile: parseSessionProfile({
      commands: { deny: [{ reason: 'sealed', paths: ['/data/secret'] }] },
    }),
  })
  const free = ws.createSession('free')
  const ns = (ws as unknown as { namespace: { ensureLoaded: () => Promise<void> } }).namespace
  const loaded = ns.ensureLoaded.bind(ns)
  const [hold, release] = gate()
  const [entered, enter] = gate()
  const [freeHeld, releaseFree] = gate()
  try {
    await ws.vfs.write('/data/secret', 'secret')
    const refusal = (run: Promise<unknown>): Promise<string> =>
      run.then(
        () => 'read',
        (error: unknown) => (error as Error).message,
      )
    const alone = await refusal(ws.vfs.forSession('sealed').read('/data/secret'))
    let first = true
    ns.ensureLoaded = async () => {
      if (first) {
        first = false
        enter()
        await hold
      }
      return loaded()
    }
    const reading = refusal(ws.vfs.forSession('sealed').read('/data/secret'))
    await entered
    const other = runWithSession(free, () => freeHeld, { owner: ws.sessionManager })
    release()
    const overlapped = await reading
    releaseFree()
    await other
    expect(alone).not.toBe('read')
    expect(overlapped).toBe(alone)
  } finally {
    ns.ensureLoaded = loaded
    release()
    releaseFree()
    await ws.close()
  }
})

it('expands an ambient glob under every live session’s hides', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const hider = ws.createSession('hider', {
    profile: parseSessionProfile({ paths: { hide: ['/data/secret'] } }),
  })
  const wide = ws.createSession('wide')
  const [held, release] = gate()
  const [entered, enter] = gate()
  const [wideHeld, releaseWide] = gate()
  let seen: string[] = []
  ws.registerCli(
    'globber',
    new CLI({
      spec: new CommandSpec({ name: 'globber' }),
      handlers: {
        '': new CLIHandler({
          fn: async () => {
            enter()
            await held
            seen = await ws.glob('/data/*')
            return [null, new IOResult()]
          },
        }),
      },
    }),
  )
  try {
    await ws.vfs.write('/data/secret', 's')
    await ws.vfs.write('/data/open', 'o')
    const line = ws.shell('globber', { sessionId: hider.sessionId })
    await entered
    const other = runWithSession(wide, () => wideHeld, { owner: ws.sessionManager })
    release()
    await line
    releaseWide()
    await other
    expect(seen).toEqual(['/data/open'])
  } finally {
    release()
    releaseWide()
    await ws.close()
  }
})

it('checks a link target under the caller’s own view while a peer hides the link', async () => {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const peer = ws.createSession('peer', {
    profile: parseSessionProfile({ paths: { hide: ['/data/link'] } }),
  })
  const [held, release] = gate()
  const [entered, enter] = gate()
  ws.registerCli(
    'pause',
    new CLI({
      spec: new CommandSpec({ name: 'pause' }),
      handlers: {
        '': new CLIHandler({
          fn: async () => {
            enter()
            await held
            return [null, new IOResult()]
          },
        }),
      },
    }),
  )
  const sealed: Policy = {
    preCommand: (ctx) =>
      Promise.resolve(
        ctx.paths.some((p) => p.virtual === '/data/secret')
          ? { kind: 'deny', reason: 'sealed' }
          : null,
      ),
  }
  try {
    await ws.vfs.write('/data/secret', 'top secret')
    await ws.shell('ln -s /data/secret /data/link')
    ws.policies.add(sealed)
    const paused = ws.shell('pause', { sessionId: peer.sessionId })
    await entered
    const io = await ws.shell('cat /data/link')
    release()
    await paused
    expect([io.exitCode === 0, io.stdoutText]).toEqual([false, ''])
  } finally {
    release()
    await ws.close()
  }
})

it('glob traversal keeps its captured signal across overlapping fallback sessions', async () => {
  const first = new SessionState({ sessionId: 'glob-first' })
  const other = new SessionState({ sessionId: 'glob-other' })
  const wanted = new AbortController()
  const unwanted = new AbortController()
  unwanted.abort()
  const [listed, announce] = gate()
  const [hold, release] = gate()
  const [otherHold, releaseOther] = gate()
  let calls = 0
  const read = async (): Promise<string[]> => {
    calls += 1
    if (calls === 1) {
      announce()
      await hold
      return ['/root/one']
    }
    return calls === 2 ? ['/root/one/file'] : ['/second/file']
  }
  const work = runWithLineAbort(wanted.signal, [first], newStatusWriter(), () =>
    runWithEvaluation(new EvaluationContext(first), () =>
      resolveGlobWith(
        read,
        null,
        [
          new PathSpec({
            virtual: '/root/*/*',
            vfsPath: '/*/*',
            directory: '/root/*',
            pattern: '*',
            resolved: false,
          }),
          new PathSpec({
            virtual: '/second/*',
            vfsPath: '/*',
            directory: '/second',
            pattern: '*',
            resolved: false,
          }),
        ],
        undefined,
      ),
    ),
  )
  await listed
  const overlap = runWithLineAbort(unwanted.signal, [other], newStatusWriter(), () =>
    runWithEvaluation(new EvaluationContext(other), () => otherHold),
  )
  try {
    release()
    expect((await work).map((path) => path.virtual)).toEqual(['/root/one/file', '/second/file'])
    wanted.abort()
    await expect(
      runWithLineAbort(wanted.signal, [first], newStatusWriter(), () =>
        runWithEvaluation(new EvaluationContext(first), () =>
          expandPattern(read, null, PathSpec.fromStrPath('/root/*/*', '/*/*')),
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    release()
    releaseOther()
    await overlap
  }
})

it.each([true, false])(
  'search scope keeps its owning cancellation while the tree loads (signal %s)',
  async (withSignal) => {
    const first = new SessionState({ sessionId: 'search-first' })
    const other = new SessionState({ sessionId: 'search-other' })
    const wanted = new AbortController()
    const unwanted = new AbortController()
    unwanted.abort()
    const [loaded, announce] = gate()
    const [hold, release] = gate()
    const [otherHold, releaseOther] = gate()
    const tree = new SlugTree(async () => {
      announce()
      await hold
      return new Map([['/', [new FileStat({ name: 'doc.txt', type: FileType.FILE, size: 1 })]]])
    })
    const work = runWithLineAbort(
      withSignal ? wanted.signal : undefined,
      [first],
      newStatusWriter(),
      () =>
        runWithEvaluation(new EvaluationContext(first), () =>
          searchScope(tree, null, [
            new PathSpec({
              virtual: '/root/*.txt',
              vfsPath: '/*.txt',
              directory: '/root',
              pattern: '*.txt',
              resolved: false,
            }),
          ]),
        ),
    )
    await loaded
    const overlap = runWithLineAbort(unwanted.signal, [other], newStatusWriter(), () =>
      runWithEvaluation(new EvaluationContext(other), () => otherHold),
    )
    try {
      release()
      expect((await work)[0].map((path) => path.virtual)).toEqual(['/root/doc.txt'])
    } finally {
      release()
      releaseOther()
      await overlap
    }
  },
)

describe('overlapping file tool calls on the fallback storage', () => {
  it('keep their own records whichever ends first', async () => {
    // While the second call starts, the newest live frame is the first
    // call's, recording included. The second must not take that recording
    // for a line's: the first hands its records over when it ends, and the
    // second's, recorded after, would be left in a list nobody reads.
    const [heldA, releaseA] = gate()
    const [heldB, releaseB] = gate()
    class Held extends RAMVFS {
      override async read(
        path: PathSpec,
        handed?: Handed,
        offset?: number,
        size?: number | null,
      ): Promise<Uint8Array> {
        await (path.virtual.endsWith('/a') ? heldA : heldB)
        return super.read(path, handed, offset, size)
      }
    }
    const vfs = new Held()
    vfs.store.files.set('/a', new TextEncoder().encode('a\n'))
    vfs.store.files.set('/b', new TextEncoder().encode('b\n'))
    const ws = new Workspace({ '/data': vfs }, { mode: MountMode.READ })
    try {
      const first = ws.vfs.read('/data/a')
      const second = ws.vfs.read('/data/b')
      releaseA()
      await first
      releaseB()
      await second
      expect(ws.vfs.records.map((r) => [r.op, r.path])).toEqual([
        ['read', '/data/a'],
        ['read', '/data/b'],
      ])
    } finally {
      await ws.close()
    }
  })
})
