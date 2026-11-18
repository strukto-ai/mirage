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
import { PolicyError } from '../../policy/errors.ts'
import { SessionProfile, treeDoc } from '../../policy/profile.ts'
import { ruleTable } from '../../rs/policy.ts'
import { DEFAULT_PROCESS_PERMISSIONS, layerProcesses } from '../../execution/process/config.ts'
import { VarAttr } from '../../shell/variable.ts'
import { DEFAULT_VISIBILITY, MountMode } from '../../types.ts'
import { pathVisible } from '../../utils/hidden.ts'
import {
  applyProfile,
  commandRules,
  compileProfile,
  narrow,
  resolveProfile,
  withInline,
} from './resolve.ts'
import { SessionState } from './session.ts'
import { BUILTIN_GRAMMARS } from './validate.ts'

const PROFILES: Record<string, SessionProfile> = {
  default: SessionProfile({
    cwd: '/scratch',
    env: { PAGER: 'cat' },
    mounts: { '/repo': 'r', '/scratch': 'rwx' },
  }),
  reviewer: SessionProfile({
    paths: { hide: ['/repo/.env'] },
    env: { ROLE: 'reviewer' },
  }),
}

it("withInline keeps the profile's tree and commandRules reads both", () => {
  const base = SessionProfile({ commands: { rm: { '-r': 'ask' } } })
  const inline = SessionProfile({ commands: { rm: 'deny' }, paths: { hide: ['/secret'] } })
  const merged = withInline(base, inline)
  expect(merged?.commands).toBe(base.commands)
  const rules = commandRules(base, inline, BUILTIN_GRAMMARS)
  expect(rules?.trees.map((t) => [t.mount, t.inline])).toEqual([
    ['', false],
    ['', true],
  ])
  const second = rules?.trees[1]
  expect(second === undefined ? null : treeDoc(second.tree)).toEqual({ rm: 'deny' })
  expect(compileProfile(merged, '', null, rules).policies.commands).toBe(rules)
})

describe('resolveProfile', () => {
  it('names objects and the default', () => {
    expect(resolveProfile(PROFILES, 'reviewer')).toBe(PROFILES.reviewer)
    expect(resolveProfile(PROFILES, null)).toBe(PROFILES.default)
    expect(resolveProfile({}, null)).toBeNull()
    const plain: SessionProfile = { cwd: '/x' }
    expect(resolveProfile(PROFILES, plain)).toBe(plain)
  })

  it('refuses an unknown name', () => {
    expect(() => resolveProfile(PROFILES, 'nope')).toThrow(PolicyError)
    expect(() => resolveProfile(PROFILES, 'nope')).toThrow('unknown profile "nope"')
  })
})

describe('withInline', () => {
  it('takes the weaker mode per mount', () => {
    const base = SessionProfile({ mounts: { '/a': 'rwx', '/b': 'r' } })
    const inline = SessionProfile({ mounts: { '/a': 'rw', '/c': 'rwx' } })
    const out = withInline(base, inline)
    // Every prefix either side names survives; a mount only the inline
    // document names is not a grant, since a mount the profile never named
    // was already reachable at its own mode.
    expect(out?.mounts?.get('/a')?.mode).toBe(MountMode.WRITE)
    expect(out?.mounts?.get('/b')?.mode).toBe(MountMode.READ)
    expect(out?.mounts?.get('/c')?.mode).toBe(MountMode.EXEC)
  })

  it('unions hides and lets inline presets win', () => {
    const out = withInline(
      SessionProfile({
        cwd: '/scratch',
        env: { PAGER: 'cat', A: '1' },
        paths: { hide: ['/repo/.env', '*.pem'] },
        vars: { hide: ['AWS_*'] },
      }),
      SessionProfile({
        cwd: '/repo',
        env: { A: '2' },
        paths: { hide: ['*.pem', '/repo/secrets'] },
        vars: { hide: ['SLACK_TOKEN'] },
      }),
    )
    expect(out?.cwd).toBe('/repo')
    expect(out?.env).toEqual({ PAGER: 'cat', A: '2' })
    expect(out?.paths).toEqual({ hide: ['/repo/.env', '*.pem', '/repo/secrets'] })
    expect(out?.vars).toEqual({ hide: ['AWS_*', 'SLACK_TOKEN'] })
  })

  it('merges one mount section', () => {
    const base = SessionProfile({
      mounts: {
        '/repo': {
          mode: 'rw',
          commands: { rm: 'deny' },
          paths: { hide: ['/repo/.env'] },
        },
      },
    })
    const inline = SessionProfile({
      mounts: {
        '/repo': { commands: { cp: 'ask' }, paths: { hide: ['/repo/secrets'] } },
      },
    })
    const entry = withInline(base, inline)?.mounts?.get('/repo')
    expect(entry?.mode).toBe(MountMode.WRITE)
    expect(entry?.commands == null ? null : treeDoc(entry.commands)).toEqual({ rm: 'deny' })
    const rules = commandRules(base, inline, BUILTIN_GRAMMARS)
    expect(rules?.trees.map((t) => [t.mount, t.inline])).toEqual([
      ['/repo', false],
      ['/repo', true],
    ])
    expect(entry?.paths).toEqual({ hide: ['/repo/.env', '/repo/secrets'] })
  })

  it('with one side missing is the other', () => {
    const p: SessionProfile = { cwd: '/x' }
    expect(withInline(null, p)).toBe(p)
    expect(withInline(p, null)).toBe(p)
    expect(withInline(null, null)).toBeNull()
  })
})

describe('commandRules', () => {
  it("holds each mount's tree with its prefix", () => {
    const rules = commandRules(
      SessionProfile({
        commands: { '*': 'deny', ls: 'allow' },
        mounts: {
          '/repo': {
            commands: { rm: { decision: 'deny', paths: ['*.pem'] }, git: { push: 'ask' } },
          },
        },
      }),
      null,
      BUILTIN_GRAMMARS,
      true,
    )
    expect(rules?.trees.map((t) => t.mount)).toEqual(['', '/repo'])
    const leaves = new Map((rules === null ? [] : ruleTable(rules)).map((r) => [r.at, r]))
    expect(leaves.get('/rm/*')?.paths).toEqual(['/repo/*.pem'])
    expect(leaves.get('/rm/*')?.mount).toBe('/repo')
    expect(leaves.get('/*')?.mount).toBe('')
  })

  it('is null when no document states a tree', () => {
    const bare = SessionProfile({ mounts: { '/repo': 'r' } })
    expect(commandRules(bare, null, BUILTIN_GRAMMARS)).toBeNull()
    expect(commandRules(null, null, BUILTIN_GRAMMARS)).toBeNull()
  })
})

describe('compileProfile', () => {
  it('turns the document into session fields', () => {
    const out = compileProfile(
      SessionProfile({
        cwd: '/scratch',
        env: { ROLE: 'x' },
        mounts: { '/a': 'rw', '/b': 'r' },
        paths: { hide: ['/a/secrets', '*.key'] },
        vars: { hide: ['SLACK_TOKEN', 'AWS_*'] },
      }),
    )
    expect(out.policies.mountModes).toEqual(
      new Map([
        ['/a', MountMode.WRITE],
        ['/b', MountMode.READ],
      ]),
    )
    expect(out.visibility.paths).toEqual({ paths: ['/a/secrets'], patterns: ['*.key'] })
    expect(out.visibility.vars).toEqual({ names: ['SLACK_TOKEN'], patterns: ['AWS_*'] })
    expect(out.setup.env).toEqual({ ROLE: 'x' })
    expect(out.setup.cwd).toBe('/scratch')
  })

  it('carries the name, which narrow stamps onto the session', () => {
    const profile = SessionProfile({ cwd: '/scratch' })
    expect(compileProfile(profile, 'reviewer').profile).toBe('reviewer')
    const session = new SessionState({ sessionId: 's1' })
    narrow(session, compileProfile(profile, 'reviewer'))
    expect(session.profile).toBe('reviewer')
    // A document passed without a name, and no document at all, leave
    // the session with no profile to report.
    expect(compileProfile(profile).profile).toBeNull()
    expect(compileProfile(null).profile).toBeNull()
    narrow(session, compileProfile(null))
    expect(session.profile).toBeNull()
  })

  it('collects the hides of every mount section, anchored to it', () => {
    const out = compileProfile(
      SessionProfile({
        paths: { hide: ['/shared/finance'] },
        mounts: {
          '/repo': { paths: { hide: ['/repo/.env', '*.pem'] } },
          '/scratch': 'r',
        },
      }),
    )
    // The set is one list for the whole session, so a name pattern
    // written under a mount has to carry the mount with it: raw, `*.pem`
    // would hide `/scratch/key.pem` too.
    expect(out.visibility.paths).toEqual({
      paths: ['/shared/finance', '/repo/.env'],
      patterns: ['/repo/*.pem'],
    })
    expect(pathVisible(out.visibility, '/repo/deep/key.pem')).toBe(false)
    expect(pathVisible(out.visibility, '/scratch/key.pem')).toBe(true)
    // The profile's own hide is not a mount section's and stays global.
    const profile = compileProfile(SessionProfile({ paths: { hide: ['*.pem'] } }))
    expect(pathVisible(profile.visibility, '/scratch/key.pem')).toBe(false)
  })

  it('of a bare or absent profile states nothing', () => {
    const empty = compileProfile(null)
    expect(empty).toEqual({
      setup: { env: null, cwd: null },
      visibility: DEFAULT_VISIBILITY,
      policies: {
        mountModes: null,
        commands: null,
        scripts: {},
        commandLimits: null,
        processes: DEFAULT_PROCESS_PERMISSIONS,
        network: null,
      },
      hideReasons: [],
      profile: null,
    })
    expect(compileProfile({})).toEqual(empty)
    // A profile that names a mount without a mode narrows nothing: the
    // mount keeps whatever the workspace gave it.
    expect(compileProfile(SessionProfile({ mounts: { '/a': {} } })).policies.mountModes).toBeNull()
  })
})

describe('narrow / applyProfile', () => {
  it('narrow stamps the uneditable fields, applyProfile seeds the rest', () => {
    const compiled = compileProfile(
      SessionProfile({
        cwd: '/a',
        env: { ROLE: 'x' },
        mounts: { '/a': 'rw' },
        paths: { hide: ['/a/secrets'] },
        vars: { hide: ['SLACK_TOKEN'] },
      }),
    )
    const narrowed = new SessionState({ sessionId: 's1' })
    narrow(narrowed, compiled)
    expect(narrowed.mountModes).toEqual(new Map([['/a', MountMode.WRITE]]))
    expect(narrowed.mountModes).not.toBe(compiled.policies.mountModes)
    expect(narrowed.visibility.paths).toEqual({ paths: ['/a/secrets'], patterns: [] })
    expect(narrowed.visibility.vars).toEqual({ names: ['SLACK_TOKEN'], patterns: [] })
    expect(narrowed.cwd).toBe('/')
    expect(narrowed.env.ROLE).toBeUndefined()
    const applied = new SessionState({ sessionId: 's2' })
    applyProfile(applied, compiled)
    expect(applied.mountModes).toEqual(new Map([['/a', MountMode.WRITE]]))
    expect(applied.cwd).toBe('/a')
    expect(applied.env.ROLE).toBe('x')
    expect(applied.vars.get('ROLE')?.attrs.has(VarAttr.Export)).toBe(true)
  })

  it("carries the profile's trees onto the session", () => {
    const doc = SessionProfile({ commands: { '*': 'deny', ls: 'allow' } })
    const compiled = compileProfile(doc, '', null, commandRules(doc, null, BUILTIN_GRAMMARS))
    expect(compiled.policies.commands).not.toBeNull()
    const session = new SessionState({ sessionId: 's' })
    narrow(session, compiled)
    expect(session.commands).toEqual(compiled.policies.commands)
  })

  it('the process list scope is part of what a session sees', () => {
    const seen = compileProfile(SessionProfile({ processes: 'workspace' }))
    expect(seen.visibility.processes).toBe('workspace')
    expect(seen.policies.processes.list).toBe('workspace')
    const session = new SessionState({ sessionId: 's' })
    narrow(session, seen)
    expect(session.visibility.processes).toBe('workspace')
    expect(compileProfile({ cwd: '/x' }).visibility.processes).toBe('session')
  })
})

describe('the path axis through resolve', () => {
  it("withInline cannot add show and the profile's survives", () => {
    const base = SessionProfile({
      paths: {
        hide: [{ patterns: ['/repo'], reason: 'sealed' }],
        show: ['/repo/public'],
      },
    })
    const inline = SessionProfile({
      paths: { hide: [{ patterns: ['/repo/extra'], reason: 'audit' }] },
    })
    const out = withInline(base, inline)
    // The profile's show and both sides' reasons survive the merge.
    expect(out?.paths?.show).toEqual([{ path: '/repo/public', mode: null }])
    expect(out?.paths?.hide).toEqual(['/repo', '/repo/extra'])
    expect(out?.paths?.reasons).toEqual([
      { patterns: ['/repo'], reason: 'sealed' },
      { patterns: ['/repo/extra'], reason: 'audit' },
    ])
    expect(() => withInline(base, SessionProfile({ paths: { show: ['/repo/secrets'] } }))).toThrow(
      'not show entries',
    )
    // The mount-section spelling is the same statement.
    expect(() =>
      withInline(
        base,
        SessionProfile({ mounts: { '/repo': { paths: { show: ['/repo/secrets'] } } } }),
      ),
    ).toThrow('not show entries')
    // And with no profile to add to, the same rule.
    expect(() => withInline(null, SessionProfile({ paths: { show: ['/x'] } }))).toThrow(
      'not show entries',
    )
  })

  it("withInline keeps a mount section's show", () => {
    const base = SessionProfile({
      mounts: { '/repo': { paths: { hide: ['/repo'], show: { '/repo/public': 'r' } } } },
    })
    const inline = SessionProfile({
      mounts: { '/repo': { paths: { hide: ['/repo/extra'] } } },
    })
    const entry = withInline(base, inline)?.mounts?.get('/repo')
    expect(entry?.paths?.show).toEqual([{ path: '/repo/public', mode: MountMode.READ }])
    expect(entry?.paths?.hide).toEqual(['/repo', '/repo/extra'])
  })

  it('compileProfile collects the shows of every mount section', () => {
    const out = compileProfile(
      SessionProfile({
        paths: { hide: ['/repo'], show: ['/repo/public'] },
        mounts: { '/data': { paths: { hide: ['/data'], show: { '/data/out': 'rw' } } } },
      }),
    )
    expect(out.visibility.shown).toEqual({
      entries: [
        { path: '/repo/public', mode: null },
        { path: '/data/out', mode: MountMode.WRITE },
      ],
    })
    // The axis reads them together: the show reopens its subtree.
    expect(pathVisible(out.visibility, '/repo/public/a')).toBe(true)
    expect(pathVisible(out.visibility, '/repo/x')).toBe(false)
  })

  it("compileProfile anchors a mount section's reasons", () => {
    const out = compileProfile(
      SessionProfile({
        paths: { reasons: [{ patterns: ['/shared'], reason: 'global' }] },
        mounts: {
          '/repo': { paths: { reasons: [{ patterns: ['*.pem'], reason: 'credentials' }] } },
        },
      }),
    )
    expect(out.hideReasons).toEqual([
      { patterns: ['/shared'], reason: 'global' },
      { patterns: ['/repo/*.pem'], reason: 'credentials' },
    ])
  })

  it('narrow stamps the path axis', () => {
    const compiled = compileProfile(
      SessionProfile({
        paths: { hide: [{ patterns: ['/repo'], reason: 'sealed' }], show: ['/repo/public'] },
      }),
    )
    const session = new SessionState({ sessionId: 's' })
    narrow(session, compiled)
    expect(session.visibility.shown).toEqual(compiled.visibility.shown)
    expect(session.hideReasons).toEqual(compiled.hideReasons)
    const empty = compileProfile(null)
    expect(empty.visibility.shown).toBeNull()
    expect(empty.hideReasons).toEqual([])
  })
})

describe('workspace processes', () => {
  it("layers the profile's block over the workspace's", () => {
    const workspace = { list: 'workspace', max: 4 } as const
    const capped = compileProfile(SessionProfile({ processes: { max: 9 } }), '', workspace)
    expect(capped.policies.processes).toEqual(layerProcesses([{ list: 'workspace', max: 9 }]))
    expect(capped.visibility.processes).toBe('workspace')
    expect(compileProfile(null, '', workspace).policies.processes).toEqual(
      layerProcesses([workspace]),
    )
    expect(compileProfile(null).policies.processes).toEqual(DEFAULT_PROCESS_PERMISSIONS)
  })

  it("narrows the workspace's block under a bare profile", () => {
    const workspace = { max: 4 }
    const inline = SessionProfile({ processes: { max: 9 } })
    const merged = withInline(SessionProfile({ cwd: '/x' }), inline, workspace)
    expect(merged?.processes).toMatchObject({ max: 4 })
    expect(compileProfile(merged, '', workspace).policies.processes.max).toBe(4)
    expect(withInline(null, inline, workspace)?.processes).toMatchObject({ max: 4 })
  })
})
