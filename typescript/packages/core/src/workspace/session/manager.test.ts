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

import { seedVar } from './state.ts'
import { describe, expect, it, vi } from 'vitest'
import type { AdmissionRules } from '../../policy/types.ts'
import type { CompiledProfile, ProfilePolicies, ProfileSetup } from '../../policy/profile.ts'
import { Outcome, Scope } from '../../policy/types.ts'
import { ScriptSource } from '../../runtime/types.ts'
import { MountMode, type Visibility } from '../../types.ts'
import { SessionManager } from './manager.ts'
import { Decisions } from '../../policy/decisions.ts'
import { ManualClock } from '../../utils/clock.ts'
import { compileProfile } from './resolve.ts'
import { RAMNamespaceStore } from '../mount/namespace/ram.ts'
import { SessionState, varsFromEntries } from './session.ts'
import type { RecordFields } from '../record/types.ts'
import { VarAttr, type ShellVar } from '../../shell/variable.ts'

/** An empty compiled profile with the given parts filled in. */
function compiled(
  policies: Partial<ProfilePolicies>,
  visibility: Partial<Visibility> = {},
  setup: ProfileSetup = { env: null, cwd: null },
): CompiledProfile {
  const empty = compileProfile(null)
  return {
    ...empty,
    setup,
    visibility: { ...empty.visibility, ...visibility },
    policies: { ...empty.policies, ...policies },
  }
}

describe('SessionManager', () => {
  it('seeds the default session on construction', () => {
    const m = new SessionManager('def')
    expect(m.defaultId).toBe('def')
    expect(m.get('def').sessionId).toBe('def')
    expect(m.list()).toHaveLength(1)
  })

  it('stamps sessions on its clock', () => {
    const clock = new ManualClock(1_000)
    const m = new SessionManager('def', undefined, undefined, clock)
    clock.advance(5)
    const created = m.create('other')
    expect(m.get('def').createdAt).toBe(1_000)
    expect(created.createdAt).toBe(1_005)
  })

  it('adoptDefault re-keys the placeholder before hydration', () => {
    const m = new SessionManager('minted')
    m.get('minted').cwd = '/kept'
    m.adoptDefault('stored')
    expect(m.defaultId).toBe('stored')
    expect(m.get('stored').cwd).toBe('/kept')
    expect(m.list()).toHaveLength(1)
    expect(() => m.get('minted')).toThrow()
  })

  it('adoptDefault switches to an existing session of that id', () => {
    const m = new SessionManager('minted')
    m.create('stored')
    m.adoptDefault('stored')
    expect(m.defaultId).toBe('stored')
    expect(m.list()).toHaveLength(1)
  })

  it('exposes cwd and env for the default session', () => {
    const m = new SessionManager('def')
    m.cwd = '/data'
    m.env = { K: 'V' }
    expect(m.cwd).toBe('/data')
    expect(m.env.K).toBe('V')
    expect(m.get('def').cwd).toBe('/data')
  })

  it('create adds a new session', () => {
    const m = new SessionManager('def')
    const s = m.create('sub')
    expect(s.sessionId).toBe('sub')
    expect(
      m
        .list()
        .map((x) => x.sessionId)
        .sort(),
    ).toEqual(['def', 'sub'])
  })

  it('create throws on duplicate', () => {
    const m = new SessionManager('def')
    m.create('sub')
    expect(() => m.create('sub')).toThrow(/already exists/)
  })

  it('get throws on unknown', () => {
    const m = new SessionManager('def')
    expect(() => m.get('nope')).toThrow(/unknown session/)
  })

  it('close removes a non-default session', async () => {
    const m = new SessionManager('def')
    m.create('sub')
    await m.close('sub')
    expect(m.list().map((x) => x.sessionId)).toEqual(['def'])
  })

  it('close throws on the default session', async () => {
    const m = new SessionManager('def')
    await expect(m.close('def')).rejects.toThrow(/Cannot close the default session/)
  })
})

describe('SessionManager with a session table', () => {
  it('hydrates stored sessions on ensureLoaded', async () => {
    const store = new RAMNamespaceStore()
    await store.set('restored', {
      session_id: 'restored',
      cwd: '/w',
      env: { K: 'v' },
      created_at: 1.0,
      mount_modes: { '/data': 'read' },
      functions: { f: 'f() { echo persisted; }' },
      readonly_functions: ['f'],
      exported_functions: ['f'],
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const s = m.get('restored')
    expect(s.cwd).toBe('/w')
    expect(s.env).toEqual({
      K: 'v',
      PWD: '/w',
      PATH: '/usr/bin',
      IFS: ' \t\n',
      OPTIND: '1',
      OPTERR: '1',
    })
    expect(s.mountModes?.get('/data')).toBe(MountMode.READ)
    expect(s.functions).toEqual({ f: 'f() { echo persisted; }' })
    expect(s.readonlyFunctions).toEqual(new Set(['f']))
    expect(s.exportedFunctions).toEqual(new Set(['f']))
  })

  it('locally created sessions win a hydration conflict', async () => {
    const store = new RAMNamespaceStore()
    await store.set('s1', { session_id: 's1', cwd: '/stale' })
    const m = new SessionManager('def', store)
    const local = m.create('s1')
    local.cwd = '/fresh'
    await m.ensureLoaded()
    expect(m.get('s1').cwd).toBe('/fresh')
  })

  it('default session adopts stored durable fields', async () => {
    const store = new RAMNamespaceStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: { A: '1' },
      functions: { f: 'f() { :; }' },
      readonly_functions: ['f'],
      exported_functions: ['f'],
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    expect(m.get('def').functions).toEqual({ f: 'f() { :; }' })
    expect(m.get('def').readonlyFunctions).toEqual(new Set(['f']))
    expect(m.get('def').exportedFunctions).toEqual(new Set(['f']))
    expect(m.cwd).toBe('/w')
    expect(m.env).toEqual({
      A: '1',
      PWD: '/w',
      PATH: '/usr/bin',
      IFS: ' \t\n',
      OPTIND: '1',
      OPTERR: '1',
    })
  })

  it('default session adopts stored hidden specs', async () => {
    // A restarted daemon must not wake up unrestricted: the stored
    // hidden shapes land on the default placeholder with the other
    // durable fields, or the first command after restart reads what
    // the spec hides and the next flush erases the restriction.
    const store = new RAMNamespaceStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: {},
      hidden_paths: { paths: ['/s3/secrets'], patterns: ['*.key'] },
      hidden_vars: { names: ['SLACK_TOKEN'], patterns: [] },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const dflt = m.get('def')
    expect(dflt.visibility.paths).toEqual({ paths: ['/s3/secrets'], patterns: ['*.key'] })
    expect(dflt.visibility.vars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
  })

  it("default session adopts a stored profile's programs", async () => {
    // The profile's programs are a durable restriction like the hidden
    // shapes: a store written by a scripted deployment must not wake a
    // daemon configured without a default profile unjudged, and the
    // next flush must not erase the programs from the record.
    const store = new RAMNamespaceStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: {},
      scripts: {
        pre_command: [
          {
            profile: 'judge',
            language: 'python',
            source: 'pass',
            runtime: 'pyodide',
            config: { home: '/w' },
          },
        ],
      },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const expected = {
      preCommand: [
        {
          profile: 'judge',
          script: new ScriptSource('pass', 'python'),
          runtime: 'pyodide',
          config: { home: '/w' },
          env: {},
        },
      ],
    }
    expect(m.get('def').scripts).toEqual(expected)
    expect(m.scriptsOf('def')).toEqual(expected)
  })

  it('default session adopts a stored path axis', async () => {
    // The show half and the reasons table are durable restrictions
    // like the hides beside them: dropped here, a restarted daemon's
    // carve-out would vanish and the next flush would erase both from
    // the store.
    const store = new RAMNamespaceStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: {},
      hidden_paths: { paths: ['/repo'], patterns: [] },
      shown_paths: { entries: [{ path: '/repo/public', mode: 'read' }, { path: '/repo/notes' }] },
      hide_reasons: [{ patterns: ['/repo'], reason: 'keep the bulk out of context' }],
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const dflt = m.get('def')
    expect(dflt.visibility.shown).toEqual({
      entries: [
        { path: '/repo/public', mode: MountMode.READ },
        { path: '/repo/notes', mode: null },
      ],
    })
    expect(dflt.hideReasons).toEqual([
      { patterns: ['/repo'], reason: 'keep the bulk out of context' },
    ])
  })

  it('defaultProfile shapes the default session and outranks a stale record', async () => {
    // A record written before the profile existed (or under an older
    // one) must not wake the primary agent unrestricted: the document
    // wins the narrowing fields after hydration, the record keeps the
    // scratch state (cwd, env), and the next flush rewrites the record.
    const store = new RAMNamespaceStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: { A: '1' },
      mount_modes: { '/s3': 'write', '/other': 'write' },
    })
    const m = new SessionManager('def', store)
    m.defaultProfile = compiled(
      { mountModes: new Map([['/s3', MountMode.READ]]) },
      {
        paths: { paths: ['/s3/secrets'], patterns: [] },
        vars: { names: ['SLACK_TOKEN'], patterns: [] },
      },
      { env: { PAGER: 'cat' }, cwd: '/s3' },
    )
    const dflt = m.get('def')
    expect(dflt.cwd).toBe('/s3')
    expect(dflt.env.PAGER).toBe('cat')
    expect(dflt.visibility.vars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    await m.ensureLoaded()
    expect(dflt.cwd).toBe('/w')
    expect(dflt.env.A).toBe('1')
    expect(dflt.mountModes).toEqual(new Map([['/s3', MountMode.READ]]))
    expect(dflt.visibility.paths).toEqual({ paths: ['/s3/secrets'], patterns: [] })
    await m.flush()
    const stored = (await store.load()).get('def') as {
      mount_modes: Record<string, string>
      hidden_paths: { paths: string[] }
    }
    expect(stored.mount_modes).toEqual({ '/s3': 'read' })
    expect(stored.hidden_paths.paths).toEqual(['/s3/secrets'])
    // null is "no default profile", not "clear the session".
    m.defaultProfile = null
    expect(dflt.mountModes).toEqual(new Map([['/s3', MountMode.READ]]))
  })

  it('flush writes every session through', async () => {
    const store = new RAMNamespaceStore()
    const m = new SessionManager('def', store)
    m.create('agent', { mountModes: new Map([['/s3', MountMode.READ]]) })
    m.cwd = '/moved'
    await m.flush()
    const entries = await store.load()
    expect(entries.get('def')?.cwd).toBe('/moved')
    expect(entries.get('agent')?.mount_modes).toEqual({ '/s3': 'read' })
  })

  it('close retains a terminal fence in the store', async () => {
    const store = new RAMNamespaceStore()
    const m = new SessionManager('def', store)
    m.create('gone')
    await m.flush()
    await m.close('gone')
    expect((await store.get('gone'))?.closed).toEqual(expect.any(String))
  })
})

class CountingStore extends RAMNamespaceStore {
  casCalls = 0

  override casSet(
    sessionId: string,
    fields: Parameters<RAMNamespaceStore['casSet']>[1],
    expectedGeneration: number,
  ): Promise<boolean> {
    this.casCalls += 1
    return super.casSet(sessionId, fields, expectedGeneration)
  }
}

describe('SessionManager dirty flush + CAS', () => {
  it('flush skips clean sessions', async () => {
    const store = new CountingStore()
    const m = new SessionManager('default', store)
    await m.flush()
    expect(store.casCalls).toBe(1)
    await m.flush()
    expect(store.casCalls).toBe(1)
    seedVar(m.get('default'), 'K', 'v')
    await m.flush()
    expect(store.casCalls).toBe(2)
  })

  it('flush bumps the generation', async () => {
    const store = new RAMNamespaceStore()
    const m = new SessionManager('default', store)
    await m.flush()
    expect(m.get('default').generation).toBe(1)
    m.get('default').cwd = '/data'
    await m.flush()
    expect(m.get('default').generation).toBe(2)
    expect((await store.load()).get('default')?.generation).toBe(2)
  })

  it('a conflict adopts the stored generation and retries', async () => {
    const store = new RAMNamespaceStore()
    const m = new SessionManager('default', store)
    await store.set('default', {
      session_id: 'default',
      cwd: '/theirs',
      env: {},
      generation: 5,
    })
    m.get('default').cwd = '/ours'
    await m.flush()
    const entries = await store.load()
    expect(entries.get('default')?.cwd).toBe('/ours')
    expect(entries.get('default')?.generation).toBe(6)
    expect(m.get('default').generation).toBe(6)
  })

  it('exhausted retries raise', async () => {
    class AlwaysConflict extends RAMNamespaceStore {
      override casSet(): Promise<boolean> {
        return Promise.resolve(false)
      }
    }
    const m = new SessionManager('default', new AlwaysConflict())
    m.get('default').cwd = '/data'
    await expect(m.flush()).rejects.toThrow(/conflict/)
  })

  it('hydrated sessions start clean', async () => {
    const store = new CountingStore()
    await store.set('s2', { session_id: 's2', cwd: '/data', env: {}, generation: 3 })
    const m = new SessionManager('default', store)
    await m.ensureLoaded()
    expect(m.get('s2').generation).toBe(3)
    const before = store.casCalls
    await m.flush()
    expect(store.casCalls).toBe(before + 1)
    seedVar(m.get('s2'), 'K', 'v')
    await m.flush()
    expect((await store.load()).get('s2')?.generation).toBe(4)
  })
})

describe('SessionManager admission rules', () => {
  it("commandsOf answers the session's own rules", () => {
    const m = new SessionManager('def')
    const early = m.create('early')
    const own: AdmissionRules = { allow: ['ls'], ask: [], deny: [] }
    const late = m.create('late')
    late.commands = own
    expect(m.commandsOf('late')).toBe(own)
    // A session the profile never narrowed states no rules, and so does an
    // id the manager does not know (the empty id of an unbound entry point
    // included), unless a default profile says otherwise.
    expect(m.commandsOf('early')).toBeNull()
    expect(m.commandsOf('nobody')).toBeNull()
    expect(m.commandsOf('')).toBeNull()
    expect(early.commands).toBeNull()
    // With a default profile compiled in, an unknown id answers its rules
    // rather than nothing, so an unbound entry point still fails toward refusal.
    m.defaultProfile = compiled({ commands: { allow: ['cat'], ask: [], deny: [] } })
    expect(m.commandsOf('nobody')).toEqual({ allow: ['cat'], ask: [], deny: [] })
    expect(m.commandsOf('')).toEqual({ allow: ['cat'], ask: [], deny: [] })
  })

  it('the rules ride the session record', async () => {
    const store = new RAMNamespaceStore()
    await store.set('restored', {
      session_id: 'restored',
      cwd: '/w',
      env: {},
      created_at: 1.0,
      commands: {
        allow: ['ls', 'git log'],
        ask: [],
        deny: [{ reason: 'no', commands: ['rm'], paths: [] }],
      },
    })
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: {},
      created_at: 1.0,
      commands: { allow: ['cat'], ask: [], deny: [] },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const restored = m.get('restored')
    expect(restored.commands).toEqual({
      allow: ['ls', 'git log'],
      ask: [],
      deny: [{ reason: 'no', commands: ['rm'], paths: [], mount: '' }],
    })
    expect(m.commandsOf('restored')).toBe(restored.commands)
    // The default session adopts its stored rules like its hidden paths.
    expect(m.get('def').commands).toEqual({ allow: ['cat'], ask: [], deny: [] })
    await m.flush()
    const stored = await store.load()
    const record = stored.get('restored') as {
      commands: { allow: string[]; deny: { reason: string }[] }
    }
    expect(record.commands.allow).toEqual(['ls', 'git log'])
    expect(record.commands.deny[0]?.reason).toBe('no')
  })
})

it.each(['def', 'agent'])(
  'hydrates actual session approval authority for %s',
  async (sessionId) => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('def', store)
    if (sessionId !== 'def') manager.create(sessionId)
    const decisions = new Decisions(manager)
    const ctx = { command: 'git', argv: ['push'], paths: [], cwd: '/repo', sessionId }
    const ask = {
      kind: 'ask' as const,
      reason: 'sign-off',
      rule: { reason: 'sign-off', commands: ['git push'] },
    }
    const pending = await decisions.resolve(ctx, ask)
    if (pending?.kind !== 'pending') throw new Error('Expected a pending approval')
    await decisions.answer(pending.id, Outcome.ALLOW, Scope.SESSION)
    const reopened = new SessionManager('def', store)
    await reopened.ensureLoaded()
    const restored = new Decisions(reopened)
    expect(await restored.resolve(ctx, ask)).toBeNull()
    expect(restored.pending(sessionId)).toEqual([])
  },
)

describe('hasManagedEnv', () => {
  const managed: ShellVar = {
    value: null,
    attrs: new Set([VarAttr.Export]),
    managed: { source: 'env', ref: '', key: 'TOKEN', eager: false },
  }

  it('is false for a plain manager and sticky-true once seeded', () => {
    expect(new SessionManager('s').hasManagedEnv).toBe(false)
    const mgr = new SessionManager('s', undefined, { TOKEN: managed })
    expect(mgr.hasManagedEnv).toBe(true)
  })

  it('a created session with its own managed entry flips it', () => {
    const mgr = new SessionManager('s')
    expect(mgr.hasManagedEnv).toBe(false)
    mgr.create('s2', { env: { TOKEN: { from: 'env' } } })
    expect(mgr.hasManagedEnv).toBe(true)
  })

  it('create seeds the workspace template and session entries win', () => {
    const mgr = new SessionManager('s', undefined, { TOKEN: managed })
    const session = mgr.create('s2', { env: { TOKEN: 'literal', OWN: { from: 'env' } } })
    expect(session.vars.TOKEN?.managed).toBeUndefined()
    expect(session.vars.TOKEN?.value).toBe('literal')
    expect(session.vars.OWN?.managed?.source).toBe('env')
    // The template itself is untouched: a third session still gets the
    // managed TOKEN.
    expect(mgr.create('s3', {}).vars.TOKEN?.managed).not.toBeUndefined()
  })

  it('a snapshot carrying a pointer flips it', async () => {
    const mgr = new SessionManager('s')
    const snap = new SessionState({ sessionId: 'restored', vars: { TOKEN: managed } })
    await mgr.replaceFromSnapshot([snap])
    expect(mgr.hasManagedEnv).toBe(true)
  })

  it('a hydrated record carrying a pointer flips it', async () => {
    const store = new RAMNamespaceStore()
    await store.casSet(
      'other',
      {
        session_id: 'other',
        cwd: '/',
        env: {},
        var_attrs: { TOKEN: 'x' },
        managed: { TOKEN: { from: 'env', ref: '', key: 'TOKEN' } },
        generation: 1,
      } as unknown as RecordFields,
      0,
    )
    const mgr = new SessionManager('s', store)
    await mgr.ensureLoaded()
    expect(mgr.hasManagedEnv).toBe(true)
    expect(mgr.get('other').vars.TOKEN?.managed?.source).toBe('env')
  })
})

describe('restoreSeed', () => {
  it('templates later sessions and arms the managed flag', () => {
    const mgr = new SessionManager('default')
    expect(mgr.hasManagedEnv).toBe(false)
    const seed = varsFromEntries({
      TOKEN: { from: 'aws-sm', ref: 'prod' },
      MODE: 'x',
    })
    mgr.restoreSeed(seed)
    expect(mgr.hasManagedEnv).toBe(true)
    const created = mgr.create('later')
    expect(created.vars.MODE?.value).toBe('x')
    expect(created.vars.TOKEN?.managed).not.toBeUndefined()
    expect(mgr.seedVars).toEqual(seed)
  })
})

describe('seed merge on hydration', () => {
  it('merges env entries the record predates, record entries winning', async () => {
    const store = new RAMNamespaceStore()
    const old = new SessionManager('default', store)
    old.get('default').vars.KEPT = { value: 'stored', attrs: new Set() }
    old.create('agent')
    old.get('agent').vars.KEPT = { value: 'agent', attrs: new Set() }
    await old.ensureLoaded()
    await old.flush()
    const seeds = varsFromEntries({
      TOKEN: { from: 'aws-sm', ref: 'prod' },
      KEPT: 'seeded',
    })
    const fresh = new SessionManager('default', store, seeds)
    await fresh.ensureLoaded()
    expect(fresh.get('default').vars.TOKEN?.managed).not.toBeUndefined()
    expect(fresh.get('default').vars.KEPT?.value).toBe('stored')
    expect(fresh.get('agent').vars.TOKEN?.managed).not.toBeUndefined()
    expect(fresh.get('agent').vars.KEPT?.value).toBe('agent')
    expect(fresh.hasManagedEnv).toBe(true)
  })

  it('lands the merged seed durably on the next flush', async () => {
    const store = new RAMNamespaceStore()
    const old = new SessionManager('default', store)
    await old.ensureLoaded()
    await old.flush()
    const seeds = varsFromEntries({ TOKEN: { from: 'aws-sm', ref: 'p' } })
    const fresh = new SessionManager('default', store, seeds)
    await fresh.ensureLoaded()
    await fresh.flush()
    const entries = await store.load()
    const record = entries.get('default') as { managed?: Record<string, { ref: string }> }
    expect(record.managed?.TOKEN?.ref).toBe('p')
  })
})

it.each([false, true])(
  'publishes profile changes only after persistence (failure=%s)',
  async (failure) => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('default', store)
    const original = compiled(
      {
        mountModes: new Map([['/data', MountMode.READ]]),
        commands: { allow: ['cat'], ask: [], deny: [] },
        scripts: {
          preCommand: [
            {
              profile: 'judge',
              script: new ScriptSource('pass', 'python'),
              runtime: 'monty',
              config: {},
              env: {},
            },
          ],
        },
      },
      {
        paths: { paths: ['/data/secret'], patterns: [] },
        vars: { names: ['TOKEN'], patterns: [] },
      },
    )
    manager.defaultProfile = original
    await manager.flush()
    const session = manager.get('default')
    const before = session.toDict()
    const persisted = await store.load()
    let enter = (): void => undefined
    let resume = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    const casSet = store.casSet.bind(store)
    const spy = vi.spyOn(store, 'casSet').mockImplementation(async (...args) => {
      enter()
      await release
      if (failure) throw new Error('store unavailable')
      return casSet(...args)
    })
    const cleared = compileProfile(null)
    const updating = manager.setProfile('default', cleared).then(
      (value) => value,
      (error: unknown) => error,
    )
    try {
      await entered
      expect(session.toDict()).toEqual(before)
      expect(manager.commandsOf('')).toEqual(original.policies.commands)
      expect(manager.scriptsOf('')).toEqual(original.policies.scripts)
      session.cwd = '/changed-during-write'
      resume()
      if (failure) {
        expect(await updating).toEqual(new Error('store unavailable'))
        expect(session.toDict()).toEqual({ ...before, cwd: session.cwd })
        expect(await store.load()).toEqual(persisted)
        expect(manager.commandsOf('')).toEqual(original.policies.commands)
        expect(manager.scriptsOf('')).toEqual(original.policies.scripts)
      } else {
        expect(await updating).toBe(session)
        expect(session.mountModes).toBeNull()
        expect(session.visibility.paths).toBeNull()
        expect(manager.commandsOf('')).toBeNull()
        expect(manager.scriptsOf('')).toEqual({})
      }
      expect(session.cwd).toBe('/changed-during-write')
      spy.mockRestore()
      await manager.flush()
      expect((await store.load()).get('default')).toEqual(session.toDict())
    } finally {
      resume()
      await updating
      spy.mockRestore()
    }
  },
)

it.each([false, true])(
  'session close waits for profile persistence (failure=%s)',
  async (failure) => {
    const store = new RAMNamespaceStore()
    const manager = new SessionManager('default', store)
    manager.create('agent')
    let enter = (): void => undefined
    let resume = (): void => undefined
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const release = new Promise<void>((resolve) => {
      resume = resolve
    })
    const casSet = store.casSet.bind(store)
    let firstWrite = true
    const spy = vi.spyOn(store, 'casSet').mockImplementation(async (...args) => {
      const first = firstWrite
      firstWrite = false
      enter()
      await release
      if (failure && first) throw new Error('store unavailable')
      return casSet(...args)
    })
    const updating = manager
      .setProfile('agent', compileProfile(null))
      .catch((error: unknown) => error)
    let closing: Promise<void> | undefined
    try {
      await entered
      let closed = false
      closing = manager.close('agent').then(() => {
        closed = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(closed).toBe(false)
      resume()
      await updating
      await closing
      expect(() => manager.get('agent')).toThrow('unknown session')
      expect((await store.get('agent'))?.closed).toEqual(expect.any(String))
    } finally {
      resume()
      await updating
      await closing
      spy.mockRestore()
    }
  },
)

it('a final flush after session deletion does not recreate it', async () => {
  const store = new RAMNamespaceStore()
  const manager = new SessionManager('default', store)
  manager.create('gone')
  await manager.flush('gone')
  await manager.close('gone')
  await manager.flush('gone')
  expect((await store.get('gone'))?.closed).toEqual(expect.any(String))
})

it('retires the old default root before a snapshot rekeys the session', async () => {
  const store = new RAMNamespaceStore()
  const manager = new SessionManager('old', store)
  const old = await manager.activate('old')
  await manager.restoreDefault('new')
  expect(manager.defaultId).toBe('new')
  expect(manager.has('old')).toBe(false)
  const closed = await store.get('old')
  expect(closed?.closed).toEqual(expect.any(String))
  expect(manager.approvalStateOf('old')).toEqual(closed?.approval_state)
  await expect(
    manager.approvalEvent('old', { op: 'revoke', owner: 'owner', holder: 'holder' }, old),
  ).resolves.toEqual({ kind: 'applied' })
  await expect(manager.activate('old')).rejects.toThrow('session_closed')
  await manager.replaceFromSnapshot([manager.get('new')])
  expect(await manager.activate('new')).not.toBe(old)
})

it('keeps the old default until its retirement is confirmed and retries the same fence', async () => {
  const store = new RAMNamespaceStore()
  const manager = new SessionManager('old', store)
  const epoch = await manager.activate('old')
  const casSet = store.casSet.bind(store)
  let rejectAcknowledgement = true
  const spy = vi.spyOn(store, 'casSet').mockImplementation(async (...args) => {
    const placed = await casSet(...args)
    if (placed && args[1].closed != null && rejectAcknowledgement) {
      throw new Error('acknowledgement lost')
    }
    return placed
  })
  try {
    await expect(manager.restoreDefault('new')).rejects.toThrow('storage_unconfirmed')
    expect(manager.defaultId).toBe('old')
    expect(manager.has('new')).toBe(false)
    const fenced = await store.get('old')
    await expect(
      manager.approvalEvent('old', { op: 'revoke', owner: 'owner', holder: 'holder' }, epoch),
    ).rejects.toThrow('session_transition_pending')
    rejectAcknowledgement = false
    await manager.restoreDefault('new')
    expect(manager.defaultId).toBe('new')
    expect((await store.get('old'))?.incarnation).toBe(fenced?.incarnation)
    expect((await store.get('old'))?.closed).toBe(fenced?.closed)
  } finally {
    spy.mockRestore()
  }
})

it('restores an imported session into a missing destination with a fresh root', async () => {
  const source = new SessionManager('restored')
  const importedEpoch = await source.activate('restored')
  const imported = source.get('restored').fork()
  const store = new RAMNamespaceStore()
  const target = new SessionManager('default', store)
  await target.replaceFromSnapshot([imported])
  const current = await store.get('restored')
  expect(current?.incarnation).toEqual(expect.any(String))
  expect(current?.incarnation).not.toBe(importedEpoch)
  expect(current?.generation).toBe(1)
})
