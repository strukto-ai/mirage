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
import { cliSpecFor } from '../../commands/cli/specs.ts'
import { CLI, CLIHandler } from '../../commands/cli/types.ts'
import { Argument, CommandSpec } from '../../commands/spec/types.ts'
import { IOResult } from '../../io/types.ts'
import { commandTree, SessionProfile, treeDoc } from '../../policy/profile.ts'
import {
  type AdmissionRules,
  AllowFlags,
  type CommandRule,
  type Grammar,
} from '../../policy/types.ts'
import { MountMode } from '../../types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace.ts'
import {
  BUILTIN_GRAMMARS,
  checkCliPatterns,
  checkRules,
  closedCommands,
  envFilled,
  logger,
  normalizeTree,
  patternWarnings,
  unreadPatterns,
} from './validate.ts'

function rules(over: Partial<AdmissionRules> = {}): AdmissionRules {
  return { allow: null, ask: [], deny: [], ...over }
}

function rule(over: Partial<CommandRule> & { reason: string }): CommandRule {
  return { commands: [], paths: [], mount: '', ...over }
}

describe('checkRules', () => {
  it('refuses a rule on a builtin the allow list omits', () => {
    // The whole point of the check: `rm` reads as guarded in the
    // document and is not guarded at all, because it was never
    // installed, so nothing ever reaches the rule.
    expect(() => {
      checkRules(rules({ allow: ['ls', 'cat'], deny: [rule({ reason: 'no', commands: ['rm'] })] }))
    }).toThrow(/never allows/)
    expect(() => {
      checkRules(rules({ allow: ['ls'], ask: [rule({ reason: 'sign-off', commands: ['rm'] })] }))
    }).toThrow(/never allows/)
  })

  it('passes a rule on an installed builtin', () => {
    checkRules(rules({ allow: ['ls', 'rm'], deny: [rule({ reason: 'no', commands: ['rm'] })] }))
    // No allow list installs everything, so nothing is dead.
    checkRules(rules({ deny: [rule({ reason: 'no', commands: ['rm'] })] }))
  })

  it('leaves a word that is not a builtin alone', () => {
    // It may be a CLI the host registers after the workspace is built,
    // which is what checkCliPatterns covers at createSession.
    checkRules(rules({ allow: ['ls'], deny: [rule({ reason: 'no', commands: ['mycli run'] })] }))
  })

  it('refuses an ask an outranking deny covers', () => {
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
          deny: [rule({ reason: 'no', commands: ['rm'] })],
        }),
      )
    }).toThrow(/can never fire/)
    // A shorter deny pattern covers a longer ask.
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['git push'] })],
          deny: [rule({ reason: 'no', commands: ['git'] })],
        }),
      )
    }).toThrow(/can never fire/)
    // A deny naming no commands refuses everything.
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
          deny: [rule({ reason: 'no' })],
        }),
      )
    }).toThrow(/can never fire/)
  })

  it('allows a deny that leaves the ask work', () => {
    // Path-scoped: the ask still fires on every operand the deny does
    // not name.
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
        deny: [rule({ reason: 'no', commands: ['rm'], paths: ['/prod/*'] })],
      }),
    )
    // A longer deny does not cover a shorter ask.
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['git'] })],
        deny: [rule({ reason: 'no', commands: ['git push'] })],
      }),
    )
    // An ask naming two commands the deny only half covers.
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['rm', 'mv'] })],
        deny: [rule({ reason: 'no', commands: ['rm'] })],
      }),
    )
  })

  it('does not let a mount-scoped deny kill a rule outside it', () => {
    checkRules(
      rules({
        ask: [rule({ reason: 'sign-off', commands: ['rm'] })],
        deny: [rule({ reason: 'no', commands: ['rm'], mount: '/repo' })],
      }),
    )
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['rm'], mount: '/repo' })],
          deny: [rule({ reason: 'no', commands: ['rm'], mount: '/repo' })],
        }),
      )
    }).toThrow(/can never fire/)
  })

  it('leaves a deny at a different anchor to the run', () => {
    // A top-level deny does shadow a mount-scoped ask on the same
    // command, but across anchors the deeper rule leads and which one
    // that is depends on the line, so this reports nothing rather than
    // guess. `conflict_a_later_tiers_deny_outranks_an_earlier_tiers_ask`
    // in integ/session/commands/conflicts.json is exactly that document.
    checkRules(
      rules({
        ask: [rule({ reason: 'log it', commands: ['git branch'], mount: '/repo' })],
        deny: [rule({ reason: 'no branches', commands: ['git branch'] })],
      }),
    )
  })

  it('reads a wildcard token in a deny as covering whatever the ask names', () => {
    expect(() => {
      checkRules(
        rules({
          ask: [rule({ reason: 'sign-off', commands: ['git push'] })],
          deny: [rule({ reason: 'no', commands: ['git *'] })],
        }),
      )
    }).toThrow(/can never fire/)
  })

  it('passes when there is nothing to check', () => {
    checkRules(null)
    checkRules(rules())
  })
})

const GIT: Grammar = {
  spec: new CommandSpec({
    name: 'git',
    subcommands: [
      new CommandSpec({ name: 'status' }),
      new CommandSpec({
        name: 'remote',
        subcommands: [
          new CommandSpec({
            name: 'add',
            arguments: [new Argument(['-f', '--fetch'], { action: 'store_true' })],
          }),
        ],
      }),
      new CommandSpec({
        name: 'add',
        arguments: [
          new Argument(['-f', '--force'], { action: 'store_true' }),
          new Argument(['--dry-run'], { action: 'store_true' }),
        ],
      }),
    ],
  }),
  tree: true,
  passthrough: false,
}

function deny(...patterns: string[]): AdmissionRules {
  return rules({ deny: [rule({ reason: 'no', commands: patterns })] })
}

describe('checkCliPatterns', () => {
  const trees = new Map([['git', GIT]])

  it.each([
    ['git shove', 'has no verb git shove'],
    ['git remote shove', 'has no verb git remote shove'],
    ['git add --dry', '--dry is a prefix of an option'],
    ['git * -f', 'write its long name'],
    ['git * --prune', 'no git subcommand the * stands for has --prune'],
    ['git {status,shove}', 'has no verb git shove'],
    ['git add --frobnicate', 'git add does not read --frobnicate'],
  ])('refuses %s, which its tree cannot read', (pattern, says) => {
    expect(() => {
      checkCliPatterns(deny(pattern), trees)
    }).toThrow(says)
  })

  it.each([
    'git status',
    'git *',
    'git * --force',
    'git * * --fetch',
    'git add -f',
    'git',
    'slack send --now',
  ])('loads %s, which its tree reads', (pattern) => {
    checkCliPatterns(deny(pattern), trees)
    checkCliPatterns(null, trees)
  })
})

describe('a cobra pattern reads as its run does', () => {
  const trees = new Map<string, Grammar>([
    ['gh', { spec: cliSpecFor('gh').spec, tree: true, passthrough: false }],
  ])

  it.each([
    ['gh pr merge --adm', '--adm is a prefix of an option'],
    ['gh pr merge --bogus', 'gh pr merge does not read --bogus'],
  ])('refuses %s', (pattern, says) => {
    expect(() => {
      checkCliPatterns(deny(pattern), trees)
    }).toThrow(says)
  })

  it('may leave out an operand and an option value', () => {
    checkCliPatterns(deny('gh pr merge --admin', 'gh * list --state'), trees)
    checkRules(deny('cp -r', 'mv -f', 'head -n'))
  })
})

describe('a git pattern naming an option git lacks', () => {
  const trees = new Map<string, Grammar>([
    ['git', { spec: cliSpecFor('git').spec, tree: true, passthrough: false }],
  ])

  it('loads and is warned', () => {
    const r = deny('git add --frce', 'git add -- --x', 'git rev-parse --zzqq')
    checkCliPatterns(r, trees)
    expect(unreadPatterns(r, trees)).toEqual([
      'commands.deny: git add --frce: git declares no --frce there, so it matches only a line with --frce as an operand',
      'commands.deny: git rev-parse --zzqq: git declares no --zzqq there, so it matches only a line with --zzqq as an operand',
    ])
    const clean = deny('git add --force', 'git log -5', 'git add --help', 'git *')
    checkCliPatterns(clean, trees)
    expect(unreadPatterns(clean, trees)).toEqual([])
  })
})

describe('a flags entry the profile env closes', () => {
  const trees = new Map<string, Grammar>([
    ['git', { spec: cliSpecFor('git').spec, tree: true, passthrough: false }],
  ])

  it('is warned until its flags list the option', () => {
    const closed = rules({ allow: ['*', new AllowFlags('git', [])] })
    expect(envFilled(closed, new Set(['GIT_DIR', 'HOME']), trees)).toEqual([
      'commands.allow: git: env sets GIT_DIR, which fills --git-dir, so this refuses git until its flags list --git-dir',
    ])
    const listed = rules({ allow: [new AllowFlags('git', ['--git-dir'])] })
    expect(envFilled(listed, new Set(['GIT_DIR']), trees)).toEqual([])
    expect(envFilled(closed, new Set(['HOME']), trees)).toEqual([])
  })
})

describe('the allow list names each command an entry closes', () => {
  it('lists the entries beside * as a note', () => {
    const r = rules({ allow: ['*', 'gh pr {view,diff}', new AllowFlags('rm', ['-f'])] })
    expect(closedCommands(r)).toEqual([
      'commands.allow closes gh to: gh pr view, gh pr diff',
      'commands.allow closes rm to: rm -f',
    ])
    expect(closedCommands(rules({ allow: ['ls', 'rm'] }))).toEqual([])
    expect(patternWarnings(r).some((m) => m.includes('closes'))).toBe(false)
    const noted: string[] = []
    logger.info = (message) => noted.push(message)
    try {
      checkRules(r)
    } finally {
      delete logger.info
    }
    expect(noted).toContain('commands.allow closes gh to: gh pr view, gh pr diff')
  })
})

describe('checkRules reads a builtin pattern with its spec', () => {
  it.each([
    ['rm --no-such-flag', 'rm has no option --no-such-flag'],
    ['rm --rec', '--rec is a prefix of an option'],
    ['rm -Z', 'rm has no option -Z'],
    ['rm --help --rec', '--rec is a prefix of an option'],
    ['rm --help -Z', 'rm has no option -Z'],
  ])('refuses %s', (pattern, says) => {
    expect(() => {
      checkRules(deny(pattern))
    }).toThrow(says)
    expect(() => {
      checkRules(rules({ allow: [pattern] }))
    }).toThrow(says)
  })

  it('loads a pattern in any spelling', () => {
    checkRules(deny('rm -rf', 'rm --recursive --force', 'head -n 1'))
    checkRules(rules({ allow: [new AllowFlags('rm', ['-f', '-v'])] }))
    expect(() => {
      checkRules(rules({ allow: [new AllowFlags('rm', ['-Z'])] }))
    }).toThrow('rm has no option -Z')
  })

  it('warns of a group in the name and a * in the allow list', () => {
    const said: string[] = []
    logger.warn = (message) => said.push(message)
    try {
      checkRules(rules({ allow: ['*', 'gh * view'], deny: deny('{rm,mv} -f').deny }))
    } finally {
      delete logger.warn
    }
    expect(said.some((m) => m.includes('{rm,mv} -f: a group in the command name'))).toBe(true)
    expect(said.some((m) => m.includes('gh * view: a * admits every subcommand'))).toBe(true)
  })
})

function noopVerb(): [null, IOResult] {
  return [null, new IOResult()]
}

describe('createSession reads the verbs of an installed CLI', () => {
  it('refuses a rule naming a verb the CLI does not declare', () => {
    // Reached through the workspace, not the helper, because the wiring
    // is the part that broke: this read the registry with
    // Object.entries over a Map and silently saw no CLIs at all, so the
    // check passed everything.
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    ws.registerCli(
      'prog',
      new CLI({
        spec: new CommandSpec({ name: 'prog', subcommands: [new CommandSpec({ name: 'run' })] }),
        handlers: { run: new CLIHandler({ fn: noopVerb }) },
      }),
    )
    expect(() =>
      ws.createSession('bad', {
        permissions: SessionProfile({
          commands: { deny: [{ reason: 'no', commands: ['prog walk'] }] },
        }),
      }),
    ).toThrow(/has no verb/)
    ws.createSession('good', {
      permissions: SessionProfile({
        commands: { deny: [{ reason: 'no', commands: ['prog run'] }] },
      }),
    })
  })
})

describe('createSession reads the verbs of a tree a mount serves', () => {
  it('refuses a verb the tree lacks and loads one it has', () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    ws.mount('/data').registerCommands([
      new CLI({
        spec: new CommandSpec({
          name: 'tool',
          subcommands: [
            new CommandSpec({
              name: 'peek',
              arguments: [new Argument(['--all'], { action: 'store_true' })],
            }),
          ],
        }),
        handlers: { peek: new CLIHandler({ fn: noopVerb }) },
      }),
    ])
    const deny = (pattern: string) =>
      SessionProfile({ commands: { deny: [{ reason: 'no', commands: [pattern] }] } })
    const said: string[] = []
    logger.warn = (message) => said.push(message)
    try {
      expect(() => ws.createSession('bad', { permissions: deny('tool poke') })).toThrow(
        /has no verb tool poke/,
      )
      ws.createSession('good', { permissions: deny('tool peek --all') })
    } finally {
      delete logger.warn
    }
    expect(said.some((m) => m.includes('tool has no grammar'))).toBe(false)
  })
})

const grammars = (): Map<string, Grammar> => {
  const out = new Map(BUILTIN_GRAMMARS)
  for (const name of ['gh', 'git'])
    out.set(name, { spec: cliSpecFor(name).spec, tree: true, passthrough: false })
  return out
}

const normalized = (doc: unknown, defer = false): Record<string, unknown> =>
  treeDoc(normalizeTree(commandTree(doc), grammars(), 'commands', defer))

describe('normalizeTree', () => {
  it('holds each name by its canonical spelling', () => {
    const written = {
      rm: { '-r': 'ask', '-f': 'deny', '-i': 'allow' },
      gh: { pr: { ls: 'deny', merge: { '-R': 'ask' } } },
      git: { '-C': 'deny', checkout: { operands: { main: 'deny' } } },
      head: { '-n': { values: { '-5': 'deny' } } },
    }
    expect(normalized(written)).toEqual({
      rm: { '--recursive': 'ask', '--force': 'deny', '-i': 'allow' },
      gh: { pr: { list: 'deny', merge: { '--repo': 'ask' } } },
      git: { '-C': 'deny', checkout: { operands: { main: 'deny' } } },
      head: { '--lines': { values: { '-5': 'deny' } } },
    })
  })

  it.each([
    [{ gh: { pr: { mrge: 'deny' } } }, 'no subcommand mrge'],
    [{ gh: { pr: { merge: { '--amdin': 'deny' } } } }, 'no option --amdin'],
    [
      { gh: { pr: { merge: { admin: 'deny' } } } },
      'admin is no subcommand here; an operand goes under operands',
    ],
    [{ gh: { operands: { x: 'deny' } } }, 'takes a subcommand'],
    [{ kubectl: { '--namespace': 'deny' } }, 'no grammar here'],
    [{ kubectl: { get: 'deny' } }, 'get is no subcommand here'],
    [{ rm: { '-r': 'ask', '--recursive': 'deny' } }, 'same option'],
    [{ gh: { pr: { ls: 'deny', list: 'allow' } } }, 'same subcommand'],
    [{ rm: { '-rf': 'deny' } }, 'cluster of options; write -r and -f'],
    [{ git: { '-f': 'deny' } }, '-f names different options below'],
    [{ rm: { '--force': { values: { x: 'deny' } } } }, 'takes no value'],
    [{ git: { status: { '-u': { values: { some: 'deny' } } } } }, "takes none of 'some'"],
  ])('refuses a name its grammar lacks or reads two ways %#', (doc, says) => {
    expect(() => normalizeTree(commandTree(doc), grammars())).toThrow(says)
  })

  it('keeps operands on a command with no grammar, and can wait for one', () => {
    expect(normalized({ kubectl: { operands: { get: 'deny' } } })).toEqual({
      kubectl: { operands: { get: 'deny' } },
    })
    expect(normalized({ kubectl: { '--namespace': 'deny' } }, true)).toEqual({
      kubectl: { '--namespace': 'deny' },
    })
  })
})
