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
import { ScriptSource } from '../runtime/types.ts'
import { MountMode } from '../types.ts'
import {
  checkMountModes,
  commandTree,
  compileProgram,
  parseProfileMounts,
  parseProfilePolicy,
  profileFromDict,
  ProfileMount,
  profileToDict,
  SessionProfile,
  treeDoc,
} from './profile.ts'
import { Outcome, type RuleLeaf } from './types.ts'

const mountSection = (raw: unknown): unknown => ProfileMount(raw, '/repo', 'mounts[/repo]')

describe('SessionProfile', () => {
  it('regroups paths and vars and normalizes mounts', () => {
    const p = SessionProfile({
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
    expect(SessionProfile({})).toEqual({})
  })

  it('a mount section carries a mode, rules and hides', () => {
    const p = SessionProfile({
      mounts: {
        '/repo': {
          mode: 'rw',
          commands: { git: { push: 'deny', rebase: 'ask' } },
          paths: { hide: ['/repo/.env'] },
        },
      },
    })
    const entry = p.mounts?.get('/repo')
    expect(entry?.mode).toBe(MountMode.WRITE)
    expect(entry?.commands == null ? null : treeDoc(entry.commands)).toEqual({
      git: { push: 'deny', rebase: 'ask' },
    })
    expect(entry?.paths).toEqual({ hide: ['/repo/.env'] })
  })

  it('a flat commands block fails with the new format named', () => {
    for (const block of [
      { allow: ['ls'] },
      { deny: [{ reason: 'x', command: 'rm', paths: ['/a'] }] },
    ]) {
      expect(() => SessionProfile({ commands: block })).toThrow('old flat format')
      expect(() => SessionProfile({ mounts: { '/repo': { commands: block } } })).toThrow(
        'old flat format',
      )
      expect(() => mountSection({ commands: block })).toThrow('old flat format')
    }
  })

  it('refuses a bare list of mounts', () => {
    // A list used to mean "only these mounts are reachable"; a mount a
    // profile does not name now keeps its own mode, so the list would
    // quietly drop the confinement it used to carry.
    expect(() => SessionProfile({ mounts: ['/repo'] })).toThrow(
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
    expect(() => SessionProfile({ mounts })).toThrow(message)
    expect(() => parseProfileMounts(mounts)).toThrow(message)
  })

  it('rejects unknown and unshipped fields loudly', () => {
    expect(() => SessionProfile({ extends: 'default' })).toThrow(/unknown field `extends`/)
    expect(() => SessionProfile({ hidden_paths: {} })).toThrow(/unknown field `hidden_paths`/)
    expect(() => SessionProfile({ hiddenPaths: {} })).toThrow(/unknown field/)
    expect(() => SessionProfile({ commands: { hide: [] } })).toThrow()
    expect(() => SessionProfile({ paths: { carve: {} } })).toThrow(/paths: unknown field `carve`/)
    expect(() => SessionProfile({ vars: { mask: [] } })).toThrow(/unknown field `mask`/)
    expect(() => SessionProfile({ mounts: { '/a': 'w' } })).toThrow(/invalid mount mode/)
    expect(() => SessionProfile({ env: { A: 1 } })).toThrow(/env.A must be a string/)
    expect(() => SessionProfile([])).toThrow(/must be a mapping/)
    // A mount's own permissions block is gone: the section is the block.
    expect(() => SessionProfile({ mounts: { '/repo': { permissions: {} } } })).toThrow(
      /unknown field `permissions`/,
    )
  })

  it('processes takes a scope or its fields, and keeps only what it states', () => {
    expect(SessionProfile({ processes: 'workspace' }).processes).toEqual({
      list: 'workspace',
      kill: 'workspace',
    })
    expect(SessionProfile({ processes: { max: 4 } }).processes).toEqual({ max: 4 })
    for (const bad of [
      'none',
      { list: 'session', kill: 'workspace' },
      { max: 0 },
      { max: true },
      { spawn: false },
    ])
      expect(() => SessionProfile({ processes: bad })).toThrow(/processes/)
  })

  it.each(['xxx', 'secrets/*', './x', '~/x', 'a/b'])(
    'refuses a relative path everywhere: %s',
    (entry) => {
      // Every path in the document is a virtual path: `xxx` would
      // silently read as `/xxx` and `secrets/*` as `/secrets/*`. A name
      // pattern (no slash) is the one relative spelling with a meaning,
      // and it means the same thing inside a mount section as outside.
      expect(() => SessionProfile({ paths: { hide: [entry] } })).toThrow(/is relative/)
      expect(() => SessionProfile({ mounts: { '/repo': { paths: { hide: [entry] } } } })).toThrow(
        /is relative/,
      )
      SessionProfile({ paths: { hide: ['/' + entry, '*.pem', '?'] } })
    },
  )

  it.each(['/other/x', '/repository/x', '/'])(
    "a mount section's paths must lie under that mount: %s",
    (entry) => {
      // The section is about that mount, so a path written under it
      // names something inside it. This is what a rebase used to do by
      // joining, which turned `/repo/secret` under `/repo` into
      // `/repo/repo/secret` and protected nothing.
      expect(() => SessionProfile({ mounts: { '/repo': { paths: { hide: [entry] } } } })).toThrow(
        /outside the mount/,
      )
      // The root itself, anything under it, and a name pattern all pass.
      const ok = SessionProfile({
        mounts: { '/repo': { paths: { hide: ['/repo', '/repo/a', '*.pem'] } } },
      })
      expect(ok.mounts?.get('/repo')?.paths?.hide).toEqual(['/repo', '/repo/a', '*.pem'])
    },
  )

  it('refuses a blank hide entry, in a profile and in a mount section', () => {
    // "" is the root under the subtree rule: it would hide the whole tree.
    expect(() => SessionProfile({ paths: { hide: ['/a', ''] } })).toThrow(
      /hide\[1\] must name a path/,
    )
    expect(() => SessionProfile({ mounts: { '/a': { paths: { hide: ['/a/x', ''] } } } })).toThrow(
      /hide\[1\] must name a path/,
    )
  })

  it('paths.show takes a mapping or a plain list', () => {
    // A mapping states path -> mode; a plain list inherits the mount's
    // mode, which the entry records as null until the mode law asks.
    const p = SessionProfile({
      paths: { hide: ['/repo'], show: { '/repo/public': 'r', '/repo/build': 'rw' } },
    })
    expect(p.paths?.show).toEqual([
      { path: '/repo/public', mode: MountMode.READ },
      { path: '/repo/build', mode: MountMode.WRITE },
    ])
    const bare = SessionProfile({ paths: { show: ['/repo/public', '/repo/docs/*'] } })
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
      expect(() => SessionProfile({ paths: { show: [entry] } })).toThrow(
        /anchor to a place|must name a path/,
      )
    },
  )

  it('a show mode must be a mode name or alias', () => {
    expect(() => SessionProfile({ paths: { show: { '/repo/public': 7 } } })).toThrow(
      /mode name or alias/,
    )
    expect(() => SessionProfile({ paths: { show: { '/repo/public': 'admin' } } })).toThrow(
      /invalid mount mode/,
    )
  })

  it('a hide group carries its reason into the side table', () => {
    // The group is a spelling of `hide`: its patterns join the flat list
    // (so matching never consults the reason) and the reason lands in
    // `reasons`, which no agent-facing surface renders.
    const p = SessionProfile({
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
    expect(() => SessionProfile({ paths: { hide: [group] } })).toThrow(message)
  })

  it("a mount section's show must lie under that mount", () => {
    expect(() =>
      SessionProfile({ mounts: { '/repo': { paths: { show: { '/other/x': 'r' } } } } }),
    ).toThrow(/outside the mount/)
    const ok = SessionProfile({
      mounts: { '/repo': { paths: { hide: ['/repo'], show: ['/repo/public'] } } },
    })
    expect(ok.mounts?.get('/repo')?.paths?.show).toEqual([{ path: '/repo/public', mode: null }])
  })

  it("the root mount's section holds every path under it", () => {
    // A workspace mounted at `/` has one section to write, and `root +
    // '/'` is `'//'` there, which no path starts with, so the boundary
    // check used to leave it able to name nothing but `/` itself.
    const profile = SessionProfile({
      mounts: {
        '/': {
          paths: { hide: ['/secret', '*.pem'] },
          commands: { '*': { decision: 'deny', reason: 'sealed' } },
        },
      },
    })
    const root = profile.mounts?.get('/')
    expect(root?.paths?.hide).toEqual(['/secret', '*.pem'])
    expect(root?.commands?.decision[0]?.reason).toBe('sealed')
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

  it('refuses a glob key, which is a literal path', () => {
    expect(() => parseProfileMounts({ '/data/*/sub': { commands: { rm: 'deny' } } })).toThrow(
      'mounts[/data/*/sub]: a key is a literal path, not a glob; write one key per folder',
    )
    expect(() => parseProfileMounts({ '/data/k?ep': 'read' })).toThrow(
      'mounts[/data/k?ep]: a key is a literal',
    )
  })
})

describe('checkMountModes', () => {
  it('refuses a mode on a key that is not a mount', () => {
    const profile = SessionProfile({ mounts: { '/data': 'read', '/data/keep/deep': 'read' } })
    expect(() => {
      checkMountModes(profile, ['/', '/data/', '/other/'])
    }).toThrow(
      'mounts[/data/keep/deep]: a mode applies to a whole mount and /data/keep/deep is not one; ' +
        'put the mode on the mount /data, or give the folder a mode with mounts[/data].paths.show',
    )
  })

  it('keeps a mode outside every mount but the root', () => {
    const profile = SessionProfile({
      mounts: {
        '/': 'read',
        '/data': 'read',
        '/data/sub': 'read',
        '/later': 'read',
        '/later/deep': 'read',
        '/data/keep': { commands: { rm: 'deny' }, paths: { hide: ['/data/keep/x'] } },
      },
    })
    expect(() => {
      checkMountModes(profile, ['/', '/data/', '/data/sub/'])
    }).not.toThrow()
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
  it("reads a program's inline source as a JSON profile spells it", () => {
    const policy = parseProfilePolicy(
      { pre_network: [{ script: { source: 'print(1)', language: 'python' } }] },
      'policy',
    )
    expect(policy.preNetwork?.[0]?.script).toEqual(new ScriptSource('print(1)', 'python', false))
    for (const script of [
      { source: 1 },
      { source: 'x', language: 'ruby' },
      { source: 'x', path: 'p' },
      ['x'],
    ]) {
      expect(() => parseProfilePolicy({ pre_network: [{ script }] }, 'policy')).toThrow(
        /must be a script path or source/,
      )
    }
  })

  it("reads a program's env of literals and pointers, and compiles it", () => {
    const policy = parseProfilePolicy(
      {
        pre_command: [
          {
            script: 'p.py',
            env: {
              LLM_URL: 'https://llm/v1',
              LLM_KEY: { from: '1password', ref: 'op://v/llm', key: 'credential' },
            },
          },
        ],
      },
      'policy',
    )
    const env = {
      LLM_URL: 'https://llm/v1',
      LLM_KEY: { from: '1password', ref: 'op://v/llm', key: 'credential' },
    }
    expect(policy.preCommand?.[0]?.env).toEqual(env)
    const [program] = policy.preCommand ?? []
    if (program === undefined) throw new Error('no program')
    expect(compileProgram({ ...program, script: new ScriptSource('pass') }, 'p').env).toEqual(env)
  })

  it.each([[{ MIRAGE_POLICY_CTX: 'x' }], [{ K: 1 }], [{ K: { from: 'env' } }], [['K']]])(
    'refuses a malformed program env %j',
    (env) => {
      expect(() =>
        parseProfilePolicy({ pre_command: [{ script: 'p.py', env }] }, 'policy'),
      ).toThrow()
    },
  )

  it('keeps an env entry named __proto__ as its own', () => {
    const raw = JSON.parse('{"__proto__": "x", "K": {"from": "env", "key": "K"}}') as unknown
    const policy = parseProfilePolicy({ pre_command: [{ script: 'p.py', env: raw }] }, 'policy')
    const env = policy.preCommand?.[0]?.env ?? {}
    expect(Object.keys(env)).toEqual(['__proto__', 'K'])
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype)
  })

  it('writes no env for a program without one', () => {
    const doc = profileToDict({ policy: { preCommand: [{ script: new ScriptSource('pass') }] } })
    const [written] = (doc.policy as { pre_command: Record<string, unknown>[] }).pre_command
    expect(written !== undefined && 'env' in written).toBe(false)
  })

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
        env: {
          LLM_URL: 'https://llm/v1',
          LLM_KEY: { from: 'aws-sm', ref: 'prod/llm', key: 'key' },
        },
      },
    ],
  },
  command_limits: {
    cat: { max_bytes: 10, max_lines: null, on_exceed: 'truncate' },
  },
  processes: { list: 'workspace', kill: 'workspace', max: null },
  mounts: {
    '/repo': {
      mode: 'read',
      paths: { hide: ['/repo/.env'], show: { '/repo/.env.example': null }, reasons: [] },
      commands: {
        git: { push: { decision: 'ask', reason: 'sign-off' }, rebase: 'deny' },
      },
    },
    '/scratch': { mode: 'exec', commands: { rm: { decision: 'ask', reason: 'shared' } } },
  },
  paths: {
    hide: ['/repo/secrets', '*.pem'],
    show: { '/repo/secrets/public': 'read' },
    reasons: [{ patterns: ['*.pem'], reason: 'keys' }],
  },
  commands: {
    '*': 'deny',
    ls: 'allow',
    cat: 'allow',
    git: { push: 'allow' },
    rm: 'allow',
    curl: 'deny',
  },
}

describe('profileToDict', () => {
  it('writes the document it parses from', () => {
    expect(profileToDict(profileFromDict(DOCUMENT))).toEqual(DOCUMENT)
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

it.each([
  [
    { commands: { rm: { decision: 'deny', paths: ['/d/keep/*'] } } },
    'profile.commands.rm: a rule takes no paths; scope it to a folder with mounts[/d/keep].commands.rm',
  ],
  [
    { commands: { gh: { '--admin': { decision: 'ask', paths: ['/r'] } } } },
    'profile.commands.gh.--admin: a rule takes no paths; scope it to a folder with mounts[/r].commands.gh.--admin',
  ],
  [
    { commands: { rm: { decision: 'deny', paths: ['/d/keep/**'] } } },
    'profile.commands.rm: a rule takes no paths; scope it to a folder with mounts[/d/keep].commands.rm',
  ],
  [
    { commands: { cat: { decision: 'deny', paths: ['*.pem'] } } },
    'profile.commands.cat: a rule takes no paths; scope it to each folder with mounts[<folder>].commands.cat, or hide those paths with paths.hide',
  ],
  [
    { commands: { rm: { decision: 'deny', paths: [''] } } },
    'profile.commands.rm: a rule takes no paths; scope it to each folder with mounts[<folder>].commands.rm, or hide those paths with paths.hide',
  ],
  [
    {
      mounts: { '/d': { commands: { rm: ['allow', { decision: 'deny', paths: ['/d/keep/*'] }] } } },
    },
    'profile.mounts[/d].commands.rm[1]: a rule takes no paths; scope it to a folder with mounts[/d/keep].commands.rm',
  ],
])('refuses a rule with paths and names the folder entry to write: %j', (doc, message) => {
  expect(() => SessionProfile(doc)).toThrow(message)
})

it('refuses an explicit null command reason', () => {
  expect(() => SessionProfile({ commands: { rm: { decision: 'deny', reason: null } } })).toThrow(
    'reason',
  )
})

const TREE = {
  '*': 'allow',
  rm: { decision: 'ask', reason: 'Deletes need sign-off' },
  gh: { '*': 'deny', pr: { view: 'allow', merge: { '*': 'allow', '--admin': 'deny' } } },
  curl: { '--request': { values: { DELETE: 'deny', POST: { '--insecure': 'deny' } } } },
  git: { '--force': 'deny', checkout: { operands: { main: 'deny', 'release/*': 'ask' } } },
  cp: {
    '*': ['ask', { decision: 'deny', reason: 'kept' }],
    '-*': 'deny',
    '--recursive': { '--force': 'deny' },
  },
}

const leaf = (decision: Outcome, reason = ''): RuleLeaf => ({ decision, reason })

describe('commandTree', () => {
  it('reads names, options, operands and values', () => {
    const tree = commandTree(TREE)
    expect(tree.decision).toEqual([leaf(Outcome.ALLOW)])
    expect(tree.subcommands.get('rm')?.decision).toEqual([
      leaf(Outcome.ASK, 'Deletes need sign-off'),
    ])
    const merge = tree.subcommands.get('gh')?.subcommands.get('pr')?.subcommands.get('merge')
    expect(merge?.options.get('--admin')?.decision).toEqual([leaf(Outcome.DENY)])
    const request = tree.subcommands.get('curl')?.options.get('--request')
    expect(request?.decision).toEqual([])
    expect(request?.values.get('POST')?.options.get('--insecure')?.decision).toEqual([
      leaf(Outcome.DENY),
    ])
    const checkout = tree.subcommands.get('git')?.subcommands.get('checkout')
    expect(checkout?.operands.get('release/*')?.decision).toEqual([leaf(Outcome.ASK)])
    const cp = tree.subcommands.get('cp')
    expect(cp?.decision).toEqual([leaf(Outcome.ASK), leaf(Outcome.DENY, 'kept')])
    expect(cp?.otherOptions).toEqual([leaf(Outcome.DENY)])
    expect(cp?.options.get('--recursive')?.options.get('--force')?.decision).toEqual([
      leaf(Outcome.DENY),
    ])
  })

  it('writes the block it reads from', () => {
    const tree = commandTree(TREE)
    expect(treeDoc(tree)).toEqual(TREE)
    expect(commandTree(treeDoc(tree))).toEqual(tree)
    const spelledLong = { gh: { '*': { decision: 'deny' }, pr: { '*': 'allow' } } }
    expect(treeDoc(commandTree(spelledLong))).toEqual({ gh: { '*': 'deny', pr: 'allow' } })
  })

  it.each([
    [{ allow: ['git status'] }, 'old flat format'],
    [{ deny: [{ reason: 'x', paths: ['/s'] }] }, 'old flat format'],
    [{ curl: { '--request': { DELETE: 'deny' } } }, 'a value goes under values'],
    [{ '--force': 'deny' }, 'needs a command'],
    [{ gh: { pr: 'allow', operands: { x: 'deny' } } }, 'operands sit'],
    [{ rm: 'maybe' }, 'is no decision'],
    [{ rm: [] }, 'lists no decision'],
  ])('refuses a misshapen block %#', (block, message) => {
    expect(() => commandTree(block)).toThrow(message)
  })
})
