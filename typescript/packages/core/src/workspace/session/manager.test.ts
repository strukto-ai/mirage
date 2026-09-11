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
import type { AdmissionRules, Decision } from '../../policy/types.ts'
import type { CompiledProfile } from '../../policy/profile.ts'
import { Outcome, Scope } from '../../policy/types.ts'
import { ScriptSource } from '../../runtime/routing/types.ts'
import { MountMode } from '../../types.ts'
import { SessionManager } from './manager.ts'
import { RAMSessionStore } from './ram.ts'
import { Session, varsFromEntries } from './session.ts'
import type { SessionFields } from './store.ts'
import { VarAttr, type ShellVar } from '../../shell/variable.ts'

describe('SessionManager', () => {
  it('seeds the default session on construction', () => {
    const m = new SessionManager('def')
    expect(m.defaultId).toBe('def')
    expect(m.get('def').sessionId).toBe('def')
    expect(m.list()).toHaveLength(1)
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

  it('closeAll keeps default but drops others', async () => {
    const m = new SessionManager('def')
    m.create('a')
    m.create('b')
    await m.closeAll()
    expect(m.list().map((x) => x.sessionId)).toEqual(['def'])
  })
})

describe('SessionManager with a SessionStore', () => {
  it('hydrates stored sessions on ensureLoaded', async () => {
    const store = new RAMSessionStore()
    await store.set('restored', {
      session_id: 'restored',
      cwd: '/w',
      env: { K: 'v' },
      created_at: 1.0,
      mount_modes: { '/data': 'read' },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const s = m.get('restored')
    expect(s.cwd).toBe('/w')
    expect(s.env).toEqual({ K: 'v', PWD: '/w' })
    expect(s.mountModes?.get('/data')).toBe(MountMode.READ)
  })

  it('locally created sessions win a hydration conflict', async () => {
    const store = new RAMSessionStore()
    await store.set('s1', { session_id: 's1', cwd: '/stale' })
    const m = new SessionManager('def', store)
    const local = m.create('s1')
    local.cwd = '/fresh'
    await m.ensureLoaded()
    expect(m.get('s1').cwd).toBe('/fresh')
  })

  it('default session adopts stored durable fields', async () => {
    const store = new RAMSessionStore()
    await store.set('def', { session_id: 'def', cwd: '/w', env: { A: '1' } })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    expect(m.cwd).toBe('/w')
    expect(m.env).toEqual({ A: '1', PWD: '/w' })
  })

  it('default session adopts stored hidden specs', async () => {
    // A restarted daemon must not wake up unrestricted: the stored
    // hidden shapes land on the default placeholder with the other
    // durable fields, or the first command after restart reads what
    // the spec hides and the next flush erases the restriction.
    const store = new RAMSessionStore()
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
    expect(dflt.hiddenPaths).toEqual({ paths: ['/s3/secrets'], patterns: ['*.key'] })
    expect(dflt.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
  })

  it('default session adopts a stored profile script', async () => {
    // The profile script is a durable restriction like the hidden
    // shapes: a store written by a scripted deployment must not wake a
    // daemon configured without a default profile unjudged, and the
    // next flush must not erase the script from the record.
    const store = new RAMSessionStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: {},
      script: { profile: 'judge', language: 'js', source: 'null', runtime: 'quickjs' },
    })
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const expected = {
      profile: 'judge',
      script: new ScriptSource('null', 'js'),
      runtime: 'quickjs',
    }
    expect(m.get('def').script).toEqual(expected)
    expect(m.scriptOf('def')).toEqual(expected)
  })

  it('default session adopts a stored path axis', async () => {
    // The show half and the reasons table are durable restrictions
    // like the hides beside them: dropped here, a restarted daemon's
    // carve-out would vanish and the next flush would erase both from
    // the store.
    const store = new RAMSessionStore()
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
    expect(dflt.shownPaths).toEqual({
      entries: [
        { path: '/repo/public', mode: MountMode.READ },
        { path: '/repo/notes', mode: null },
      ],
    })
    expect(dflt.hideReasons).toEqual([
      { patterns: ['/repo'], reason: 'keep the bulk out of context' },
    ])
    expect(m.hideReasonsOf('def')).toEqual(dflt.hideReasons)
    expect(m.hideReasonsOf('stranger')).toEqual([])
  })

  it('defaultProfile shapes the default session and outranks a stale record', async () => {
    // A record written before the profile existed (or under an older
    // one) must not wake the primary agent unrestricted: the document
    // wins the narrowing fields after hydration, the record keeps the
    // scratch state (cwd, env), and the next flush rewrites the record.
    const store = new RAMSessionStore()
    await store.set('def', {
      session_id: 'def',
      cwd: '/w',
      env: { A: '1' },
      mount_modes: { '/s3': 'write', '/other': 'write' },
    })
    const m = new SessionManager('def', store)
    m.defaultProfile = {
      mountModes: new Map([['/s3', MountMode.READ]]),
      hiddenPaths: { paths: ['/s3/secrets'], patterns: [] },
      hiddenVars: { names: ['SLACK_TOKEN'], patterns: [] },
      env: { PAGER: 'cat' },
      cwd: '/s3',
      commands: null,
    }
    const dflt = m.get('def')
    expect(dflt.cwd).toBe('/s3')
    expect(dflt.env.PAGER).toBe('cat')
    expect(dflt.hiddenVars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    await m.ensureLoaded()
    expect(dflt.cwd).toBe('/w')
    expect(dflt.env.A).toBe('1')
    expect(dflt.mountModes).toEqual(new Map([['/s3', MountMode.READ]]))
    expect(dflt.hiddenPaths).toEqual({ paths: ['/s3/secrets'], patterns: [] })
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
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    m.create('agent', { mountModes: new Map([['/s3', MountMode.READ]]) })
    m.cwd = '/moved'
    await m.flush()
    const entries = await store.load()
    expect(entries.get('def')?.cwd).toBe('/moved')
    expect(entries.get('agent')?.mount_modes).toEqual({ '/s3': 'read' })
  })

  it('close deletes the session from the store', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    m.create('gone')
    await m.flush()
    await m.close('gone')
    expect((await store.load()).has('gone')).toBe(false)
  })
})

class CountingStore extends RAMSessionStore {
  casCalls = 0

  override casSet(
    sessionId: string,
    fields: Parameters<RAMSessionStore['casSet']>[1],
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
    const store = new RAMSessionStore()
    const m = new SessionManager('default', store)
    await m.flush()
    expect(m.get('default').generation).toBe(1)
    m.get('default').cwd = '/data'
    await m.flush()
    expect(m.get('default').generation).toBe(2)
    expect((await store.load()).get('default')?.generation).toBe(2)
  })

  it('a conflict adopts the stored generation and retries', async () => {
    const store = new RAMSessionStore()
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
    class AlwaysConflict extends RAMSessionStore {
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
    // id the manager does not know (the empty id of an unbound door
    // included), unless a default profile says otherwise.
    expect(m.commandsOf('early')).toBeNull()
    expect(m.commandsOf('nobody')).toBeNull()
    expect(m.commandsOf('')).toBeNull()
    expect(early.commands).toBeNull()
    // With a default profile compiled in, an unknown id answers its rules
    // rather than nothing, so an unbound door still fails toward refusal.
    m.defaultProfile = {
      mountModes: null,
      hiddenPaths: null,
      hiddenVars: null,
      env: null,
      cwd: null,
      commands: { allow: ['cat'], ask: [], deny: [] },
    }
    expect(m.commandsOf('nobody')).toEqual({ allow: ['cat'], ask: [], deny: [] })
    expect(m.commandsOf('')).toEqual({ allow: ['cat'], ask: [], deny: [] })
  })

  it('the rules ride the session record', async () => {
    const store = new RAMSessionStore()
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

describe('SessionManager decision ledger', () => {
  const RULE = { reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }

  function record(id: string, sessionId: string): Decision {
    return {
      id,
      sessionId,
      agentId: 'a',
      command: 'git',
      argv: ['push'],
      cwd: '/repo',
      paths: [],
      reason: 'sign-off',
      rule: RULE,
      outcome: Outcome.ALLOW,
      scope: Scope.SESSION,
      note: '',
    }
  }

  it('live on the registered session and persist', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const live = m.create('agent')
    expect(m.decisionsOf('agent')).toEqual([])
    const entry = record('d1', 'agent')
    // Written by id onto the registered session, so a fork made before
    // or after reads the same answers through the manager, whatever
    // its own copy holds; durable at the next flush.
    const fork = live.fork()
    m.setDecisions('agent', [entry])
    expect(live.decisions).toEqual([entry])
    expect(fork.decisions).toEqual([])
    expect(m.decisionsOf(fork.sessionId)).toEqual([entry])
    expect(m.decisionSessions()).toEqual(['agent'])
    await m.flush()
    const stored = (await store.load()).get('agent') as {
      decisions: { outcome: string; scope: string }[]
    }
    expect(stored.decisions[0]?.outcome).toBe('allow')
    expect(stored.decisions[0]?.scope).toBe('session')
    // A manager reading that record back holds the answer.
    const again = new SessionManager('def', store)
    await again.ensureLoaded()
    expect(again.decisionsOf('agent')).toEqual([entry])
    expect(() => m.decisionsOf('nobody')).toThrow(/unknown session/)
  })

  it('hydrate onto the default session', async () => {
    const store = new RAMSessionStore()
    const m = new SessionManager('def', store)
    await m.ensureLoaded()
    const entry = record('d2', 'def')
    m.setDecisions('def', [entry])
    await m.flush()
    // The default session takes the stored durable fields on reopen;
    // the records are among them, so an approved line does not ask
    // again after a restart and the next flush keeps the answer.
    const again = new SessionManager('def', store)
    await again.ensureLoaded()
    expect(again.decisionsOf('def')).toEqual([entry])
    await again.flush()
    const stored = (await store.load()).get('def') as { decisions: { scope: string }[] }
    expect(stored.decisions[0]?.scope).toBe('session')
  })
})

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
    const snap = new Session({ sessionId: 'restored', vars: { TOKEN: managed } })
    await mgr.replaceFromSnapshot([snap])
    expect(mgr.hasManagedEnv).toBe(true)
  })

  it('a hydrated record carrying a pointer flips it', async () => {
    const store = new RAMSessionStore()
    await store.casSet(
      'other',
      {
        session_id: 'other',
        cwd: '/',
        env: {},
        var_attrs: { TOKEN: 'x' },
        managed: { TOKEN: { from: 'env', ref: '', key: 'TOKEN' } },
        generation: 1,
      } as unknown as SessionFields,
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
    const store = new RAMSessionStore()
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
    const store = new RAMSessionStore()
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
    const store = new RAMSessionStore()
    const manager = new SessionManager('default', store)
    const original: CompiledProfile = {
      mountModes: new Map([['/data', MountMode.READ]]),
      hiddenPaths: { paths: ['/data/secret'], patterns: [] },
      hiddenVars: { names: ['TOKEN'], patterns: [] },
      env: null,
      cwd: null,
      commands: { allow: ['cat'], ask: [], deny: [] },
      script: { profile: 'judge', script: new ScriptSource('null', 'js'), runtime: 'quickjs' },
    }
    manager.defaultProfile = original
    await manager.flush()
    const session = manager.get('default')
    const before = session.toJSON()
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
    const cleared: CompiledProfile = {
      mountModes: null,
      hiddenPaths: null,
      hiddenVars: null,
      env: null,
      cwd: null,
      commands: null,
    }
    const updating = manager.setProfile('default', cleared).then(
      (value) => value,
      (error: unknown) => error,
    )
    try {
      await entered
      expect(session.toJSON()).toEqual(before)
      expect(manager.commandsOf('')).toEqual(original.commands)
      expect(manager.scriptOf('')).toEqual(original.script)
      session.cwd = '/changed-during-write'
      resume()
      if (failure) {
        expect(await updating).toEqual(new Error('store unavailable'))
        expect(session.toJSON()).toEqual({ ...before, cwd: session.cwd })
        expect(await store.load()).toEqual(persisted)
        expect(manager.commandsOf('')).toEqual(original.commands)
        expect(manager.scriptOf('')).toEqual(original.script)
      } else {
        expect(await updating).toBe(session)
        expect(session.mountModes).toBeNull()
        expect(session.hiddenPaths).toBeNull()
        expect(manager.commandsOf('')).toBeNull()
        expect(manager.scriptOf('')).toBeNull()
      }
      expect(session.cwd).toBe('/changed-during-write')
      spy.mockRestore()
      await manager.flush()
      expect((await store.load()).get('default')).toEqual(session.toJSON())
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
    const store = new RAMSessionStore()
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
    const spy = vi.spyOn(store, 'casSet').mockImplementation(async (...args) => {
      enter()
      await release
      if (failure) throw new Error('store unavailable')
      return casSet(...args)
    })
    const updating = manager
      .setProfile('agent', {
        mountModes: null,
        hiddenPaths: null,
        hiddenVars: null,
        env: null,
        cwd: null,
        commands: null,
      })
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
      expect((await store.load()).has('agent')).toBe(false)
    } finally {
      resume()
      await updating
      await closing
      spy.mockRestore()
    }
  },
)
