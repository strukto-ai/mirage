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

import { makeVar, VarAttr, withValue } from '../../shell/variable.ts'
import { seedVar, setAttr } from './state.ts'
import { varsFromEntries, varsFromEnv, varsFromFields, varsToFields } from './session.ts'
import { describe, expect, it } from 'vitest'
import { Session } from './session.ts'
import { MountMode } from '../../types.ts'
import type { AdmissionRules, Decision } from '../../policy/types.ts'
import { Outcome, Scope } from '../../policy/types.ts'

describe('Session', () => {
  it('defaults cwd=/ and an env holding only the seeded $PWD', () => {
    const s = new Session({ sessionId: 'x' })
    expect(s.cwd).toBe('/')
    // bash exports $PWD from startup, so even a session that never ran
    // `cd` has one.
    expect(s.env).toEqual({ PWD: '/' })
    expect(s.functions).toEqual({})
    expect(s.lastExitCode).toBe(0)
  })

  it('cwd and env are mutable', () => {
    const s = new Session({ sessionId: 'x' })
    s.cwd = '/data'
    seedVar(s, 'FOO', 'bar')
    expect(s.cwd).toBe('/data')
    expect(s.env.FOO).toBe('bar')
  })

  it('toJSON includes only the serializable fields, snake_case like Python', () => {
    const s = new Session({ sessionId: 'x', cwd: '/a', vars: varsFromEnv({ K: 'V' }) })
    const json = s.toJSON()
    expect(json).toEqual({
      session_id: 'x',
      cwd: '/a',
      env: { K: 'V', PWD: '/a' },
      // The attributes ride beside the values rather than being guessed
      // on the way back in: `varsFromEnv` exports what it seeds, so both
      // names carry `x` here, and a plain `Y=1` would carry no entry at
      // all and restore unexported.
      var_attrs: { K: 'x', PWD: 'x' },
      created_at: s.createdAt,
      generation: 0,
    })
    expect('functions' in json).toBe(false)
    expect('lastExitCode' in json).toBe(false)
  })

  it('fromJSON round-trips', () => {
    const original = new Session({ sessionId: 'x', cwd: '/a', vars: varsFromEnv({ K: 'V' }) })
    const restored = Session.fromJSON(
      original.toJSON() as {
        session_id: string
        cwd: string
        env: Record<string, string>
        created_at: number
      },
    )
    expect(restored.sessionId).toBe('x')
    expect(restored.cwd).toBe('/a')
    expect(restored.env).toEqual({ K: 'V', PWD: '/a' })
  })

  it('round-trips mountModes through toJSON/fromJSON', () => {
    const original = new Session({
      sessionId: 'x',
      mountModes: new Map([
        ['/s3', MountMode.READ],
        ['/scratch', MountMode.WRITE],
      ]),
    })
    const json = original.toJSON()
    expect(json.mount_modes).toEqual({ '/s3': 'read', '/scratch': 'write' })
    const restored = Session.fromJSON(
      json as { session_id: string; mount_modes?: Record<string, MountMode> | null },
    )
    expect(restored.mountModes?.get('/s3')).toBe(MountMode.READ)
    expect(restored.mountModes?.get('/scratch')).toBe(MountMode.WRITE)
  })

  it('toJSON omits mount_modes when unrestricted', () => {
    const s = new Session({ sessionId: 'x' })
    expect('mount_modes' in s.toJSON()).toBe(false)
    expect(Session.fromJSON({ session_id: 'x' }).mountModes).toBeNull()
  })

  it('round-trips the path axis through toJSON/fromJSON', () => {
    const original = new Session({
      sessionId: 'x',
      shownPaths: {
        entries: [
          { path: '/repo/public', mode: MountMode.READ },
          { path: '/repo/notes', mode: null },
        ],
      },
      hideReasons: [{ patterns: ['/repo/vendor'], reason: 'licensing noise' }],
    })
    const json = original.toJSON()
    expect(json.shown_paths).toEqual({
      entries: [{ path: '/repo/public', mode: 'read' }, { path: '/repo/notes' }],
    })
    expect(json.hide_reasons).toEqual([{ patterns: ['/repo/vendor'], reason: 'licensing noise' }])
    const restored = Session.fromJSON(
      json as {
        session_id: string
        shown_paths?: { entries?: { path: string; mode?: MountMode }[] } | null
        hide_reasons?: { patterns?: string[]; reason?: string }[] | null
      },
    )
    expect(restored.shownPaths).toEqual(original.shownPaths)
    expect(restored.hideReasons).toEqual(original.hideReasons)
    const forked = restored.fork({ sessionId: 'y' })
    expect(forked.shownPaths).toEqual(original.shownPaths)
    expect(forked.hideReasons).toEqual(original.hideReasons)
  })

  it('toJSON omits the path axis when the document states none', () => {
    const s = new Session({ sessionId: 'x' })
    expect('shown_paths' in s.toJSON()).toBe(false)
    expect('hide_reasons' in s.toJSON()).toBe(false)
    expect(Session.fromJSON({ session_id: 'x' }).shownPaths).toBeNull()
    expect(Session.fromJSON({ session_id: 'x' }).hideReasons).toEqual([])
  })
})

describe('Session.fork', () => {
  it('copies every field, including mountModes and shellOptions', () => {
    const original = new Session({
      sessionId: 'orig',
      cwd: '/disk',
      mountModes: new Map([
        ['/s3', MountMode.READ],
        ['/dev', MountMode.EXEC],
        ['/', MountMode.EXEC],
      ]),
      shellOptions: { errexit: true },
      vars: {
        FOO: makeVar('bar'),
        HOME: makeVar(null, new Set([VarAttr.Readonly])),
        ARGV: makeVar(['a', 'b']),
      },
      positionalArgs: ['x'],
      lastExitCode: 7,
    })
    const forked = original.fork({})
    expect(forked.sessionId).toBe('orig')
    expect(forked.cwd).toBe('/disk')
    expect(forked.env).toEqual({ FOO: 'bar', PWD: '/disk' })
    expect(forked.mountModes).toBe(original.mountModes)
    expect(forked.shellOptions).toEqual({ errexit: true })
    expect(forked.readonlyVars.has('HOME')).toBe(true)
    expect(forked.arrays).toEqual({ ARGV: ['a', 'b'] })
    expect(forked.positionalArgs).toEqual(['x'])
    expect(forked.lastExitCode).toBe(7)
  })

  it('applies overrides without mutating the original', () => {
    const original = new Session({
      sessionId: 'orig',
      cwd: '/disk',
      vars: varsFromEnv({ FOO: 'bar' }),
    })
    const forked = original.fork({ cwd: '/ram', vars: varsFromEnv({ BAZ: 'qux' }) })
    expect(forked.cwd).toBe('/ram')
    // $PWD follows the caller-supplied cwd rather than staying stale.
    expect(forked.env).toEqual({ BAZ: 'qux', PWD: '/ram' })
    expect(original.cwd).toBe('/disk')
    expect(original.env).toEqual({ FOO: 'bar', PWD: '/disk' })
  })

  // A caller-supplied cwd has no typed spelling behind it, so carrying the
  // source's logical name over would make the fork's pwd describe a
  // directory it is not in — the bug an `execute({cwd})` call hit.
  it('drops the logical cwd when the caller overrides cwd', () => {
    const original = new Session({
      sessionId: 'orig',
      cwd: '/data/deep/real',
      logicalCwd: '/data/lk',
    })
    expect(original.fork({ cwd: '/ram' }).logicalCwd).toBeUndefined()
    expect(original.fork({}).logicalCwd).toBe('/data/lk')
  })

  it('keeps an explicitly supplied logical cwd alongside a cwd override', () => {
    const original = new Session({ sessionId: 'orig', cwd: '/a' })
    const forked = original.fork({ cwd: '/data/deep/real', logicalCwd: '/data/lk' })
    expect(forked.logicalCwd).toBe('/data/lk')
  })

  it('deep-copies mutable containers so mutations on the fork do not leak', () => {
    const original = new Session({
      sessionId: 'orig',
      vars: { FOO: makeVar('bar'), A: makeVar(['1']) },
    })
    const forked = original.fork({})
    seedVar(forked, 'NEW', 'leaked?')
    forked.arrays.A?.push('2')
    expect('NEW' in original.env).toBe(false)
    expect(original.arrays.A).toEqual(['1'])
  })
})

describe('ownRecord', () => {
  it('session records treat prototype-colliding names as ordinary keys', () => {
    const session = new Session({ sessionId: 's' })
    seedVar(session, '__proto__', '5')
    expect(session.env.__proto__).toBe('5')
    expect(Object.getPrototypeOf(session.env)).toBe(null)
    // A helper defeats TS resolving `.toString` to the Object method.
    const read = (record: Record<string, string>, name: string): string | undefined => record[name]
    expect(read(session.env, 'toString')).toBeUndefined()
    expect('toString' in session.functions).toBe(false)
  })

  it('fork keeps the null prototype and copies prototype-named entries', () => {
    const session = new Session({ sessionId: 's' })
    seedVar(session, '__proto__', '5')
    const forked = session.fork()
    expect(forked.env.__proto__).toBe('5')
    expect(Object.getPrototypeOf(forked.env)).toBe(null)
    seedVar(forked, '__proto__', '6')
    expect(session.env.__proto__).toBe('5')
  })
})

describe('a stored session keeps its attributes', () => {
  it('round-trips without promoting anything', () => {
    // The bug this replaced: `toJSON` wrote every scalar under `env` and
    // `fromJSON` read `env` as a process environment, so one flush and
    // reload turned a plain `X=hello` into an exported one and shipped it
    // to every child runtime.
    const s = new Session({ sessionId: 's1' })
    seedVar(s, 'PLAIN', 'hello')
    s.vars.EXPO = makeVar('world', new Set([VarAttr.Export]))
    s.vars.MARKED = makeVar(null, new Set([VarAttr.Readonly]))
    const back = Session.fromJSON(s.toJSON() as Parameters<typeof Session.fromJSON>[0])
    expect(back.vars.PLAIN?.attrs.size).toBe(0)
    expect(back.vars.PLAIN?.value).toBe('hello')
    expect([...(back.vars.EXPO?.attrs ?? [])]).toEqual([VarAttr.Export])
    expect(back.vars.MARKED?.value).toBe(null)
    expect([...(back.vars.MARKED?.attrs ?? [])]).toEqual([VarAttr.Readonly])
  })

  it('reads a payload with no attributes as a process environment', () => {
    // An embedder's record, or one another writer hand-built, carries
    // values and no letters. That shape *is* a process environment, so
    // every name in it is exported -- which is what `ws.env = {...}` and
    // a cross-language handoff both mean.
    const back = Session.fromJSON({ session_id: 'x', env: { A: '1' } })
    expect([...(back.vars.A?.attrs ?? [])]).toEqual([VarAttr.Export])
  })

  it('writes var_attrs even when empty', () => {
    // Its *presence* is the discriminator, so it has to be there even
    // with nothing in it. Written only when non-empty, a session whose
    // last attribute had been cleared serialized as a bare process
    // environment, and the reload re-exported everything it held.
    const s = new Session({ sessionId: 's1' })
    seedVar(s, 'X', 'secret')
    setAttr(s, 'PWD', VarAttr.Export, false)
    const json = s.toJSON() as { var_attrs: Record<string, string> }
    expect(json.var_attrs).toEqual({})
    const back = Session.fromJSON(json as never)
    expect(back.vars.X?.attrs.has(VarAttr.Export)).toBe(false)
  })

  it('carries an unset marked name through with no value', () => {
    const s = new Session({ sessionId: 's1' })
    s.vars.Z = makeVar(null, new Set([VarAttr.Export]))
    const json = s.toJSON() as { env: Record<string, string>; var_attrs: Record<string, string> }
    expect('Z' in json.env).toBe(false)
    expect(json.var_attrs.Z).toBe('x')
  })
})

describe('the command tier round-trips through the record', () => {
  it('writes the Python spelling and reads it back', () => {
    const own: AdmissionRules = {
      allow: ['ls', 'git log'],
      ask: [{ reason: 'sign-off', commands: ['git push'], paths: ['/repo/*'], mount: '/repo' }],
      deny: [{ reason: 'no', commands: ['rm'] }],
    }
    const s = new Session({ sessionId: 's1', commands: own })
    const d = s.toJSON()
    expect(d.commands).toEqual({
      allow: ['ls', 'git log'],
      ask: [{ reason: 'sign-off', commands: ['git push'], paths: ['/repo/*'], mount: '/repo' }],
      deny: [{ reason: 'no', commands: ['rm'], paths: [] }],
    })
    const back = Session.fromJSON(d as Parameters<typeof Session.fromJSON>[0])
    expect(back.commands).toEqual({
      allow: ['ls', 'git log'],
      ask: [{ reason: 'sign-off', commands: ['git push'], paths: ['/repo/*'], mount: '/repo' }],
      deny: [{ reason: 'no', commands: ['rm'], paths: [], mount: '' }],
    })
    // Null means unstated and is not written; a tier without an allow
    // list writes allow as null, distinct from an empty list.
    expect('commands' in new Session({ sessionId: 's2' }).toJSON()).toBe(false)
    const bare = new Session({
      sessionId: 's3',
      commands: { allow: null, ask: [], deny: [{ reason: 'x' }] },
    })
    expect((bare.toJSON().commands as { allow: unknown }).allow).toBeNull()
    expect(bare.fork().commands).toBe(bare.commands)
  })
})

describe('ledger records round-trip through the record', () => {
  it('writes the Python spelling and reads it back', () => {
    const rule = { reason: 'sign-off', commands: ['git push'], paths: [], mount: '' }
    const base = {
      sessionId: 's1',
      agentId: 'a',
      command: 'git',
      cwd: '/repo',
      paths: [],
      reason: 'sign-off',
      rule,
      note: '',
    }
    const records: Decision[] = [
      { ...base, id: 'd1', argv: ['push'], outcome: Outcome.ALLOW, scope: Scope.SESSION },
      { ...base, id: 'd2', argv: ['push', '--force'], outcome: Outcome.DENY, scope: Scope.ONCE },
    ]
    const s = new Session({ sessionId: 's1', decisions: records })
    const d = s.toJSON() as { decisions?: { id: string; outcome: string; scope: string }[] }
    expect(d.decisions?.map((r) => [r.id, r.outcome, r.scope])).toEqual([
      ['d1', 'allow', 'session'],
      ['d2', 'deny', 'once'],
    ])
    const back = Session.fromJSON(d as Parameters<typeof Session.fromJSON>[0])
    expect(back.decisions).toEqual(records)
    // Nothing held writes nothing, and a fork carries what is held.
    expect('decisions' in new Session({ sessionId: 's2' }).toJSON()).toBe(false)
    expect(s.fork().decisions).toEqual(records)
  })
})

describe('varsFromEntries', () => {
  it('a bare string is the exported literal short form', () => {
    const vars = varsFromEntries({ APP: 'integ' })
    expect(vars.APP?.value).toBe('integ')
    expect(vars.APP?.attrs).toEqual(new Set([VarAttr.Export]))
    expect(vars.APP?.managed).toBeUndefined()
  })

  it('a literal entry compiles readonly and export attrs', () => {
    const vars = varsFromEntries({ EDITOR: { value: 'vi', readonly: true, export: false } })
    expect(vars.EDITOR?.value).toBe('vi')
    expect(vars.EDITOR?.attrs).toEqual(new Set([VarAttr.Readonly]))
  })

  it('a managed entry is exported, unset, and carries the pointer', () => {
    const vars = varsFromEntries({ TOKEN: { from: 'aws-sm', ref: 'prod/tokens', key: 'api' } })
    const v = vars.TOKEN
    expect(v?.value).toBeNull()
    expect(v?.attrs).toEqual(new Set([VarAttr.Export]))
    expect(v?.managed).toEqual({ source: 'aws-sm', ref: 'prod/tokens', key: 'api', eager: false })
  })

  it('key defaults to the variable name and eager parses', () => {
    const vars = varsFromEntries({ TOKEN: { from: 'env', fetch: 'eager' } })
    expect(vars.TOKEN?.managed).toEqual({ source: 'env', ref: '', key: 'TOKEN', eager: true })
  })

  it('an already-parsed entry passes back through', () => {
    const entry = { from: 'env', ref: '', fetch: 'lazy' as const }
    expect(varsFromEntries({ T: entry }).T?.managed?.source).toBe('env')
  })

  it('a bad entry throws naming the rule', () => {
    expect(() => varsFromEntries({ X: { value: 'v', from: 'env' } })).toThrowError(/not both/)
  })
})

describe('managed serialization', () => {
  function managedSession(value: string | null): Session {
    const session = new Session({ sessionId: 's', cwd: '/' })
    session.vars.TOKEN = {
      value,
      attrs: new Set([VarAttr.Export]),
      managed: { source: 'aws-sm', ref: 'prod/tokens', key: 'api', eager: false },
    }
    return session
  }

  it('serializes the pointer, never the value', () => {
    const data = managedSession('s3cr3t').toJSON()
    expect(JSON.stringify(data)).not.toContain('s3cr3t')
    expect((data.env as Record<string, string>).TOKEN).toBeUndefined()
    expect((data.var_attrs as Record<string, string>).TOKEN).toBe('x')
    expect(data.managed).toEqual({
      TOKEN: { from: 'aws-sm', ref: 'prod/tokens', key: 'api' },
    })
  })

  it('writes fetch only when eager', () => {
    const session = new Session({ sessionId: 's', cwd: '/' })
    session.vars.E = {
      value: null,
      attrs: new Set([VarAttr.Export]),
      managed: { source: 'env', ref: '', key: 'E', eager: true },
    }
    const data = session.toJSON()
    expect(data.managed).toEqual({ E: { from: 'env', ref: '', key: 'E', fetch: 'eager' } })
  })

  it('round-trips as declared-but-unfetched', () => {
    const data = managedSession('s3cr3t').toJSON()
    const restored = Session.fromJSON(data as Parameters<typeof Session.fromJSON>[0])
    const v = restored.vars.TOKEN
    expect(v?.value).toBeNull()
    expect(v?.attrs).toEqual(new Set([VarAttr.Export]))
    expect(v?.managed).toEqual({ source: 'aws-sm', ref: 'prod/tokens', key: 'api', eager: false })
  })

  it('discards a value a tampered payload smuggles into env', () => {
    const data = managedSession(null).toJSON()
    ;(data.env as Record<string, string>).TOKEN = 'smuggled'
    const restored = Session.fromJSON(data as Parameters<typeof Session.fromJSON>[0])
    expect(restored.vars.TOKEN?.value).toBeNull()
    expect(restored.vars.TOKEN?.managed).not.toBeUndefined()
  })
})

describe('varsToFields / varsFromFields', () => {
  it('round trips the pointer, never a value', () => {
    const table = varsFromEntries({
      TOKEN: { from: 'aws-sm', ref: 'prod', key: 'api' },
      MODE: 'prod',
    })
    const fields = varsToFields(table)
    expect(fields.env).toEqual({ MODE: 'prod' })
    expect(fields.managed).toEqual({ TOKEN: { from: 'aws-sm', ref: 'prod', key: 'api' } })
    const restored = varsFromFields(fields)
    expect(restored.TOKEN?.value).toBeNull()
    expect(restored.TOKEN?.managed).toEqual({
      source: 'aws-sm',
      ref: 'prod',
      key: 'api',
      eager: false,
    })
    expect(restored.MODE).toEqual(table.MODE)
  })

  it('round trips eager', () => {
    const table = varsFromEntries({ E: { from: 'aws-sm', ref: 'prod', fetch: 'eager' } })
    const restored = varsFromFields(varsToFields(table))
    expect(restored.E?.managed?.eager).toBe(true)
  })

  it('never writes a fetched value', () => {
    const table = varsFromEntries({ T: { from: 'aws-sm', ref: 'prod' } })
    const seeded = table.T
    if (seeded === undefined) throw new Error('seeded var missing')
    table.T = withValue(seeded, 'plain')
    const fields = varsToFields(table)
    expect(fields.env).toEqual({})
    expect(varsFromFields(fields).T?.value).toBeNull()
  })
})
