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
import { shownMode } from '../utils/hidden.ts'
import {
  parseProfileMount,
  parseProfileMounts,
  parseSessionProfile,
  profileFromJSON,
  profileToJSON,
} from './profile.ts'
import { ScriptSource } from '../runtime/routing/types.ts'

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

// One document over every block kind, spelled loosely, and the one
// document the codec writes for it; `test_profile.py` asserts the same
// two literals, so the two writers cannot drift.
const CODEC_DOCUMENT = {
  cwd: '/scratch',
  env: { PAGER: 'cat' },
  mounts: {
    '/repo': 'r',
    'scratch/': {
      mode: 'rwx',
      commands: {
        deny: ['git push'],
        ask: [{ reason: 'careful', commands: { rm: ['/scratch/keep/*'] } }],
      },
      paths: {
        hide: ['/scratch/.env', { patterns: ['/scratch/sealed/*'], reason: 'sealed' }],
        show: { '/scratch/sealed/public': 'r', '/scratch/sealed/docs': null },
      },
    },
  },
  paths: { hide: ['*.pem'], show: ['/repo/docs'] },
  vars: { hide: ['AWS_*', 'SLACK_TOKEN'] },
  commands: {
    allow: ['ls', 'cat', 'git *'],
    deny: [
      'rm',
      { reason: 'no pushes', commands: ['git push'] },
      { reason: 'sealed', paths: ['/repo/secrets'] },
    ],
    ask: [{ commands: { mv: ['/repo/*'] } }],
  },
  policy: {
    script: {
      source: 'def pre_command(ctx):\n    return None\n',
      language: 'python',
      module: false,
    },
    runtime: 'monty',
  },
}

const CODEC_WRITTEN = {
  cwd: '/scratch',
  env: { PAGER: 'cat' },
  mounts: {
    '/repo': { mode: 'read' },
    '/scratch': {
      mode: 'exec',
      commands: {
        ask: [{ reason: 'careful', commands: { rm: ['/scratch/keep/*'] } }],
        deny: ['git push'],
      },
      paths: {
        hide: ['/scratch/.env', '/scratch/sealed/*'],
        show: { '/scratch/sealed/public': 'read', '/scratch/sealed/docs': null },
        reasons: [{ patterns: ['/scratch/sealed/*'], reason: 'sealed' }],
      },
    },
  },
  paths: { hide: ['*.pem'], show: { '/repo/docs': null } },
  vars: { hide: ['AWS_*', 'SLACK_TOKEN'] },
  commands: {
    ask: [{ reason: DEFAULT_ASK_REASON, commands: { mv: ['/repo/*'] } }],
    deny: [
      'rm',
      { reason: 'no pushes', commands: ['git push'] },
      { reason: 'sealed', paths: ['/repo/secrets'] },
    ],
    allow: ['ls', 'cat', 'git *'],
  },
  policy: {
    script: {
      source: 'def pre_command(ctx):\n    return None\n',
      language: 'python',
      module: false,
    },
    runtime: 'monty',
  },
}

describe('profileToJSON / profileFromJSON', () => {
  it('writes the document grammar and reads it back', () => {
    const profile = profileFromJSON(CODEC_DOCUMENT)
    expect(profile.policy?.script).toBeInstanceOf(ScriptSource)
    const written = profileToJSON(profile)
    expect(written).toEqual(CODEC_WRITTEN)
    expect(profileFromJSON(written)).toEqual(profile)
    expect(profileToJSON(profileFromJSON(written))).toEqual(written)
  })

  it.each([
    [{}],
    [{ commands: { allow: [] } }],
    [{ vars: { hide: [] }, paths: {}, mounts: {}, env: {}, commands: {} }],
  ])('keeps a stated-but-empty block apart from an unsaid one: %j', (doc) => {
    // Null and empty are two different documents: an empty allow list
    // installs nothing, an absent one installs everything.
    const profile = profileFromJSON(doc)
    expect(profileFromJSON(profileToJSON(profile))).toEqual(profile)
  })

  it('spells what only a typed caller can build', () => {
    // Several commands beside paths have only the mapping form to travel
    // in, and read back as one rule per command.
    const both = profileFromJSON(
      profileToJSON({
        commands: {
          allow: null,
          ask: [],
          deny: [{ reason: 'r', commands: ['rm', 'mv'], paths: ['/x'] }],
        },
      }),
    )
    expect(both.commands?.deny).toEqual([
      { reason: 'r', commands: ['rm'], paths: ['/x'] },
      { reason: 'r', commands: ['mv'], paths: ['/x'] },
    ])
    // A rule naming neither is every command, which the grammar spells
    // as the wildcard.
    expect(
      profileToJSON({ commands: { allow: null, ask: [{ reason: 'all' }], deny: [] } }),
    ).toEqual({
      commands: { ask: [{ reason: 'all', commands: ['*'] }] },
    })
    // A mount stamp belongs to a compiled rule, never to a document.
    expect(() =>
      profileToJSON({
        commands: {
          allow: null,
          ask: [],
          deny: [{ reason: 'r', commands: ['rm'], mount: '/repo' }],
        },
      }),
    ).toThrow(/carries no mount/)
  })

  // The document keys a show by path, so two entries for one path have
  // one slot -- and the last one written is not the one that governs.
  // `shownMode` takes the weaker of two entries at a depth, failing
  // toward refusal, so serializing the last handed the subtree back
  // executable after a reload while the source session was read-only.
  it('serializes a duplicate show path at its weakest mode', () => {
    const show = [
      { path: '/vault/public', mode: MountMode.READ },
      { path: '/vault/public', mode: MountMode.EXEC },
    ]
    expect(profileToJSON({ paths: { hide: ['/vault'], show } })).toEqual({
      paths: { hide: ['/vault'], show: { '/vault/public': 'read' } },
    })
    // What is in force before the round trip is what comes back.
    expect(shownMode({ entries: show }, '/vault/public/f')).toEqual([2, MountMode.READ])
  })

  // A list-form entry states visibility only and answers no mode
  // question, so a stated mode beside it takes the slot rather than
  // being erased by it.
  it('does not let a list-form duplicate erase a stated mode', () => {
    for (const pair of [
      [null, MountMode.READ],
      [MountMode.READ, null],
    ]) {
      const show = pair.map((mode) => ({ path: '/vault/public', mode }))
      expect(profileToJSON({ paths: { hide: ['/vault'], show } })).toEqual({
        paths: { hide: ['/vault'], show: { '/vault/public': 'read' } },
      })
    }
  })
})
