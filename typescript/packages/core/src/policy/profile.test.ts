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

import { DEFAULT_ASK_REASON, DEFAULT_DENY_REASON } from './constants.ts'
import { MountMode } from '../types.ts'
import {
  parseProfileMount,
  parseProfileMounts,
  parseProfilePolicy,
  parseSessionProfile,
  profileFromDict,
  profileToDict,
} from './profile.ts'

const mountSection = (raw: unknown): unknown => parseProfileMount(raw, '/repo', 'mounts[/repo]')

describe('parseSessionProfile', () => {
  it('regroups paths and vars and normalizes mounts', () => {
    const p = parseSessionProfile({
      cwd: '/scratch',
      env: { PAGER: 'cat' },
      mounts: { '/repo': 'r', 'scratch/': 'rwx' },
      paths: { hide: ['/repo/.env', '*.pem'] },
      vars: { hide: ['AWS_*'] },
    })
    expect(p.cwd).toBe('/scratch')
    expect(p.env).toEqual({ PAGER: 'cat' })
    // A bare mode is sugar for the section that carries only a mode.
    expect(p.mounts).toEqual(
      new Map([
        ['/repo', { mode: MountMode.READ }],
        ['/scratch', { mode: MountMode.EXEC }],
      ]),
    )
    expect(p.paths).toEqual({ hide: ['/repo/.env', '*.pem'] })
    expect(p.vars).toEqual({ hide: ['AWS_*'] })
  })

  it('leaves unsaid fields absent so a reader can tell', () => {
    expect(parseSessionProfile({})).toEqual({})
  })

  it('a mount section carries a mode, rules and hides', () => {
    const p = parseSessionProfile({
      mounts: {
        '/repo': {
          mode: 'rw',
          commands: { deny: ['git push'], ask: ['git rebase'] },
          paths: { hide: ['/repo/.env'] },
        },
      },
    })
    const entry = p.mounts?.get('/repo')
    expect(entry?.mode).toBe(MountMode.WRITE)
    expect(entry?.commands?.deny?.[0]?.commands).toEqual(['git push'])
    expect(entry?.commands?.ask?.[0]?.commands).toEqual(['git rebase'])
    expect(entry?.paths).toEqual({ hide: ['/repo/.env'] })
    // What a session can see is the session's property, not an
    // operand's, so a mount section has no allow list.
    expect(() => mountSection({ commands: { allow: ['ls'] } })).toThrow(/unknown field `allow`/)
  })

  it('refuses a bare list of mounts', () => {
    // A list used to mean "only these mounts are reachable"; a mount a
    // profile does not name now keeps its own mode, so the list would
    // quietly drop the confinement it used to carry.
    expect(() => parseSessionProfile({ mounts: ['/repo'] })).toThrow(
      /mounts must be a mapping of prefix to its settings/,
    )
  })

  it.each([
    [new Map([[7, 'read']]), /mounts keys must be strings/],
    ['/repo', /mounts must be a mapping of prefix to its settings/],
    [7, /mounts must be a mapping of prefix to its settings/],
    [new Set(['/repo']), /mounts must be a mapping of prefix to its settings/],
    [{ '/repo': 'nope' }, /invalid mount mode: 'nope'/],
    [{ '/repo': { mode: 7 } }, /must be a mode name or alias/],
  ])('rejects the mount spellings python rejects: %j', (mounts, message) => {
    // The message is asserted, not just the throw: a mode that is not a
    // string used to reach parseMountMode and come back as a bare type
    // error, which is not the failure the loader's contract promises.
    expect(() => parseSessionProfile({ mounts })).toThrow(message)
    expect(() => parseProfileMounts(mounts)).toThrow(message)
  })

  it('rejects unknown and unshipped fields loudly', () => {
    expect(() => parseSessionProfile({ extends: 'default' })).toThrow(/unknown field `extends`/)
    expect(() => parseSessionProfile({ hidden_paths: {} })).toThrow(/unknown field `hidden_paths`/)
    expect(() => parseSessionProfile({ hiddenPaths: {} })).toThrow(/unknown field/)
    expect(() => parseSessionProfile({ commands: { hide: [] } })).toThrow(/unknown field `hide`/)
    expect(() => parseSessionProfile({ paths: { carve: {} } })).toThrow(
      /paths: unknown field `carve`/,
    )
    expect(() => parseSessionProfile({ vars: { mask: [] } })).toThrow(/unknown field `mask`/)
    expect(() => parseSessionProfile({ mounts: { '/a': 'w' } })).toThrow(/invalid mount mode/)
    expect(() => parseSessionProfile({ env: { A: 1 } })).toThrow(/env.A must be a string/)
    expect(() => parseSessionProfile([])).toThrow(/must be a mapping/)
    // A mount's own permissions block is gone: the section is the block.
    expect(() => parseSessionProfile({ mounts: { '/repo': { permissions: {} } } })).toThrow(
      /unknown field `permissions`/,
    )
  })

  it('processes takes a scope or its fields', () => {
    expect(parseSessionProfile({ processes: 'workspace' }).processes).toEqual({
      list: 'workspace',
      kill: 'workspace',
      max: null,
    })
    expect(parseSessionProfile({ processes: { max: 4 } }).processes).toEqual({
      list: 'session',
      kill: 'session',
      max: 4,
    })
    for (const bad of [
      'none',
      { list: 'session', kill: 'workspace' },
      { max: 0 },
      { max: true },
      { spawn: false },
    ])
      expect(() => parseSessionProfile({ processes: bad })).toThrow(/processes/)
  })

  it('the commands block takes allow, ask and deny', () => {
    const p = parseSessionProfile({
      commands: {
        allow: ['ls', 'git log'],
        ask: ['git push', { reason: 'sign-off', commands: { rm: ['/shared/*'] } }],
        deny: [{ reason: 'no', commands: { rm: ['/repo/*'] } }],
      },
    })
    expect(p.commands?.allow).toEqual(['ls', 'git log'])
    // A bare ask entry carries ask's default reason, not deny's.
    expect(p.commands?.ask).toEqual([
      { reason: DEFAULT_ASK_REASON, commands: ['git push'] },
      { reason: 'sign-off', commands: ['rm'], paths: ['/shared/*'] },
    ])
    expect(p.commands?.deny?.[0]?.reason).toBe('no')
    // Unstated allow is null (everything installed), not an empty list.
    expect(parseSessionProfile({ commands: { deny: ['rm'] } }).commands?.allow).toBeNull()
  })

  it.each([
    { allow: 'ls' },
    { allow: ['ls', ''] },
    { allow: ['ls', '  '] },
    { ask: 'git push' },
    { ask: [''] },
    { deny: [{ reason: 'x', commands: [''] }] },
    { ask: [{ reason: 'x', mount: '/repo' }] },
  ])('refuses scalars, blank patterns and the compiler field: %j', (bad) => {
    // A blank pattern is a prefix of every line, so it would allow, ask
    // about or deny every command; `mount` is the compiler's field.
    expect(() => parseSessionProfile({ commands: bad })).toThrow()
  })

  it('deny accepts rules and bare names', () => {
    const p = parseSessionProfile({
      commands: {
        deny: [
          { reason: 'no deletes', commands: { rm: ['/repo/*'] } },
          'python3',
          { commands: ['shred'] },
        ],
      },
      paths: { hide: ['/shared/finance'] },
    })
    expect(p.commands?.deny).toEqual([
      { reason: 'no deletes', commands: ['rm'], paths: ['/repo/*'] },
      { reason: DEFAULT_DENY_REASON, commands: ['python3'] },
      { reason: DEFAULT_DENY_REASON, commands: ['shred'], paths: [] },
    ])
    expect(p.paths).toEqual({ hide: ['/shared/finance'] })
  })

  it('requires deny itself to be a list', () => {
    for (const deny of ['rm', { rm: 'no' }, 7]) {
      expect(() => parseSessionProfile({ commands: { deny } })).toThrow(/deny must be a list/)
    }
  })

  it('maps each command to its own paths, one rule per command', () => {
    // One command to many paths, never a list of commands beside a list
    // of paths: the document says which command each path belongs to.
    const p = parseSessionProfile({
      commands: {
        deny: [
          {
            reason: 'prod is protected',
            commands: { rm: ['/repo/prod/*', '/shared/*'], mv: ['/repo/prod/*'] },
          },
        ],
        ask: [{ commands: { 'git push': ['/repo/*'] } }],
      },
    })
    expect(p.commands?.deny).toEqual([
      { reason: 'prod is protected', commands: ['rm'], paths: ['/repo/prod/*', '/shared/*'] },
      { reason: 'prod is protected', commands: ['mv'], paths: ['/repo/prod/*'] },
    ])
    expect(p.commands?.ask).toEqual([
      { reason: DEFAULT_ASK_REASON, commands: ['git push'], paths: ['/repo/*'] },
    ])
  })

  it.each([
    [{ reason: 'x', commands: ['rm', 'mv'], paths: ['/a'] }, /map each command to its paths/],
    [{ reason: 'x', commands: { rm: ['/a'] }, paths: ['/b'] }, /takes no paths of its own/],
    [{ reason: 'x' }, /names no command and no path/],
    [{ reason: 'x', commands: {} }, /must name at least one command/],
    [{ reason: 'x', commands: { rm: [] } }, /must list at least one path/],
    [{ reason: 'x', commands: { rm: '/a' } }, /must be a list of strings/],
    [{ reason: 'x', commands: { ' ': ['/a'] } }, /keys must name a command/],
    [{ reason: 'x', commands: { rm: ['/a', ' '] } }, /commands\[rm\]\[1\] must name a path/],
    [{ reason: 'x', paths: [''] }, /paths\[0\] must name a path/],
    [{ reason: 1 }, /reason must be a string/],
    [{ reason: 'x', command: ['rm'] }, /unknown field `command`/],
    [7, /must be a command pattern or a mapping/],
  ])('refuses a rule that does not say which command a path belongs to: %j', (bad, message) => {
    expect(() => parseSessionProfile({ commands: { deny: [bad] } })).toThrow(message)
    expect(() => parseSessionProfile({ commands: { ask: [bad] } })).toThrow(message)
    expect(() => mountSection({ commands: { deny: [bad] } })).toThrow(message)
  })

  it.each(['xxx', 'secrets/*', './x', '~/x', 'a/b'])(
    'refuses a relative path everywhere: %s',
    (entry) => {
      // Every path in the document is a virtual path: `xxx` would
      // silently read as `/xxx` and `secrets/*` as `/secrets/*`. A name
      // pattern (no slash) is the one relative spelling with a meaning,
      // and it means the same thing inside a mount section as outside.
      expect(() => parseSessionProfile({ paths: { hide: [entry] } })).toThrow(/is relative/)
      expect(() =>
        parseSessionProfile({ commands: { ask: [{ commands: { rm: ['/ok', entry] } }] } }),
      ).toThrow(/is relative/)
      expect(() => parseSessionProfile({ commands: { deny: [{ paths: [entry] }] } })).toThrow(
        /is relative/,
      )
      expect(() =>
        parseSessionProfile({ mounts: { '/repo': { paths: { hide: [entry] } } } }),
      ).toThrow(/is relative/)
      parseSessionProfile({ paths: { hide: ['/' + entry, '*.pem', '?'] } })
    },
  )

  it.each(['/other/x', '/repository/x', '/'])(
    "a mount section's paths must lie under that mount: %s",
    (entry) => {
      // The section is about that mount, so a path written under it
      // names something inside it. This is what a rebase used to do by
      // joining, which turned `/repo/secret` under `/repo` into
      // `/repo/repo/secret` and protected nothing.
      for (const block of [
        { paths: { hide: [entry] } },
        { commands: { deny: [{ paths: [entry] }] } },
      ]) {
        expect(() => parseSessionProfile({ mounts: { '/repo': block } })).toThrow(
          /outside the mount/,
        )
      }
      // The root itself, anything under it, and a name pattern all pass.
      const ok = parseSessionProfile({
        mounts: { '/repo': { paths: { hide: ['/repo', '/repo/a', '*.pem'] } } },
      })
      expect(ok.mounts?.get('/repo')?.paths?.hide).toEqual(['/repo', '/repo/a', '*.pem'])
    },
  )

  it('refuses a blank hide entry, in a profile and in a mount section', () => {
    // "" is the root under the subtree rule: it would hide the whole tree.
    expect(() => parseSessionProfile({ paths: { hide: ['/a', ''] } })).toThrow(
      /hide\[1\] must name a path/,
    )
    expect(() =>
      parseSessionProfile({ mounts: { '/a': { paths: { hide: ['/a/x', ''] } } } }),
    ).toThrow(/hide\[1\] must name a path/)
  })

  it('paths.show takes a mapping or a plain list', () => {
    // A mapping states path -> mode; a plain list inherits the mount's
    // mode, which the entry records as null until the mode law asks.
    const p = parseSessionProfile({
      paths: { hide: ['/repo'], show: { '/repo/public': 'r', '/repo/build': 'rw' } },
    })
    expect(p.paths?.show).toEqual([
      { path: '/repo/public', mode: MountMode.READ },
      { path: '/repo/build', mode: MountMode.WRITE },
    ])
    const bare = parseSessionProfile({ paths: { show: ['/repo/public', '/repo/docs/*'] } })
    expect(bare.paths?.show).toEqual([
      { path: '/repo/public', mode: null },
      { path: '/repo/docs/*', mode: null },
    ])
  })

  it.each(['public', '*.md', 'docs/site', ''])(
    'a show entry is absolute or refused: %j',
    (entry) => {
      // A show anchors to a place and a name pattern names none, so the
      // slashless spelling hide accepts is refused here.
      expect(() => parseSessionProfile({ paths: { show: [entry] } })).toThrow(
        /anchor to a place|must name a path/,
      )
    },
  )

  it('a show mode must be a mode name or alias', () => {
    expect(() => parseSessionProfile({ paths: { show: { '/repo/public': 7 } } })).toThrow(
      /mode name or alias/,
    )
    expect(() => parseSessionProfile({ paths: { show: { '/repo/public': 'admin' } } })).toThrow(
      /invalid mount mode/,
    )
  })

  it('a hide group carries its reason into the side table', () => {
    // The group is a spelling of `hide`: its patterns join the flat list
    // (so matching never consults the reason) and the reason lands in
    // `reasons`, which no agent-facing surface renders.
    const p = parseSessionProfile({
      paths: {
        hide: ['/repo/.env', { patterns: ['/repo/secrets', '*.pem'], reason: 'credentials' }],
      },
    })
    expect(p.paths?.hide).toEqual(['/repo/.env', '/repo/secrets', '*.pem'])
    expect(p.paths?.reasons).toEqual([
      { patterns: ['/repo/secrets', '*.pem'], reason: 'credentials' },
    ])
  })

  it.each([
    [{ patterns: [], reason: 'x' }, /at least one pattern/],
    [{ patterns: ['/a'], reason: '  ' }, /non-empty string/],
    [{ patterns: ['/a'] }, /non-empty string/],
    [{ patterns: ['/a'], reason: 'x', why: 'no' }, /unknown field/],
  ])('a malformed hide group is refused: %j', (group, message) => {
    expect(() => parseSessionProfile({ paths: { hide: [group] } })).toThrow(message)
  })

  it("a mount section's show must lie under that mount", () => {
    expect(() =>
      parseSessionProfile({ mounts: { '/repo': { paths: { show: { '/other/x': 'r' } } } } }),
    ).toThrow(/outside the mount/)
    const ok = parseSessionProfile({
      mounts: { '/repo': { paths: { hide: ['/repo'], show: ['/repo/public'] } } },
    })
    expect(ok.mounts?.get('/repo')?.paths?.show).toEqual([{ path: '/repo/public', mode: null }])
  })

  it("the root mount's section holds every path under it", () => {
    // A workspace mounted at `/` has one section to write, and `root +
    // '/'` is `'//'` there, which no path starts with, so the boundary
    // check used to leave it able to name nothing but `/` itself.
    const profile = parseSessionProfile({
      mounts: {
        '/': {
          paths: { hide: ['/secret', '*.pem'] },
          commands: { deny: [{ reason: 'sealed', paths: ['/secret/*'] }] },
        },
      },
    })
    const root = profile.mounts?.get('/')
    expect(root?.paths?.hide).toEqual(['/secret', '*.pem'])
    expect(root?.commands?.deny?.[0]?.paths).toEqual(['/secret/*'])
  })
})

describe('parseProfileMounts', () => {
  it('normalizes prefixes and takes both mapping forms', () => {
    expect(parseProfileMounts({ 'repo/': 'rw' })).toEqual(
      new Map([['/repo', { mode: MountMode.WRITE }]]),
    )
    expect(parseProfileMounts(new Map([['/a', 'rw']]))).toEqual(
      new Map([['/a', { mode: MountMode.WRITE }]]),
    )
    expect(parseProfileMounts(null)).toBeNull()
  })
})

function policyRuntime(settings: Record<string, unknown>, code: boolean): unknown {
  const policy = parseProfilePolicy(
    {
      [code ? 'preCommand' : 'pre_command']: [
        { script: 'p.py', runtime: { name: 'pyodide', config: settings } },
      ],
    },
    'policy',
    code,
  )
  return policy.preCommand?.[0]?.runtime
}

describe('parseProfilePolicy', () => {
  it("reads a runtime's settings in the document's spelling from a config, and as given from code", () => {
    expect(policyRuntime({ auto_load_from_imports: false }, false)).toEqual({
      name: 'pyodide',
      config: { autoLoadFromImports: false },
    })
    expect(policyRuntime({ autoLoadFromImports: false }, true)).toEqual({
      name: 'pyodide',
      config: { autoLoadFromImports: false },
    })
  })
})

// The document a snapshot carries, as both hosts write it: test_profile.py
// holds the same literal, so either host reads what the other wrote.
const DOCUMENT = {
  cwd: '/repo',
  env: {
    PAGER: 'cat',
    ROLE: { value: 'agent', readonly: true },
    TOKEN: { from: 'vault', ref: 'kv/agent', key: 'token' },
  },
  vars: { hide: ['TOKEN', 'AWS_*'] },
  policy: {
    pre_command: [
      {
        script: { source: 'print()', language: 'python', module: false },
        runtime: { name: 'monty', config: { auto_load_from_imports: true } },
      },
    ],
  },
  command_limits: {
    cat: { max_bytes: 10, on_exceed: 'truncate' },
  },
  processes: { list: 'workspace', kill: 'workspace', max: null },
  mounts: {
    '/repo': {
      mode: 'read',
      paths: { hide: ['/repo/.env'], show: { '/repo/.env.example': null }, reasons: [] },
      commands: {
        ask: [{ reason: 'sign-off', commands: { 'git push': ['/repo'] } }],
        deny: [{ reason: 'denied by policy', commands: ['git rebase'] }],
      },
    },
    '/scratch': { mode: 'exec' },
  },
  paths: {
    hide: ['/repo/secrets', '*.pem'],
    show: { '/repo/secrets/public': 'read' },
    reasons: [{ patterns: ['*.pem'], reason: 'keys' }],
  },
  commands: {
    ask: [{ reason: 'shared', commands: { rm: ['/scratch/*'] } }],
    deny: [
      { reason: 'sealed', paths: ['/repo/sealed'] },
      { reason: 'denied by policy', commands: ['curl'] },
    ],
    allow: ['ls', 'cat', 'git push', 'rm'],
  },
}

describe('profileToDict', () => {
  it('writes the document it parses from', () => {
    expect(profileToDict(profileFromDict(DOCUMENT))).toEqual(DOCUMENT)
    // A rule naming commands beside paths, which the document cannot
    // spell, is written one command per rule and admits the same lines.
    const profile = { commands: { deny: [{ reason: 'r', commands: ['rm', 'mv'], paths: ['/a'] }] } }
    expect(profileFromDict(profileToDict(profile)).commands?.deny).toEqual([
      { reason: 'r', commands: ['rm'], paths: ['/a'] },
      { reason: 'r', commands: ['mv'], paths: ['/a'] },
    ])
    // A path shown twice answers with its weaker mode, which the mapping
    // keeps rather than the last entry's.
    const shown = {
      paths: {
        hide: [],
        show: [
          { path: '/data', mode: MountMode.READ },
          { path: '/data', mode: MountMode.WRITE },
          { path: '/docs', mode: null },
          { path: '/docs', mode: MountMode.WRITE },
        ],
      },
    }
    expect((profileToDict(shown).paths as { show: unknown }).show).toEqual({
      '/data': 'read',
      '/docs': 'write',
    })
  })
})
