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
import { PathSpec } from '../../types.ts'
import { describe, expect, it } from 'vitest'
import { ScriptSource } from '../../runtime/types.ts'
import { CLI, CLIHandler } from './types.ts'
import { Argument, CommandSpec, UsageStyle } from '../spec/types.ts'
import {
  envNames,
  findChild,
  findNode,
  invokedEnvNames,
  nodeHelp,
  ownsArgv,
  suppliedEnvNames,
  walk,
} from './walk.ts'

const DEC = new TextDecoder()

function text(output: Uint8Array): string {
  return DEC.decode(output)
}

function tree(): CommandSpec {
  return new CommandSpec({
    name: 'gws',
    description: 'Google Workspace',
    arguments: [
      new Argument(['-C', '--cwd'], { help: 'run as if started there' }),
      new Argument(['-v', '--verbose'], { action: 'count' }),
    ],
    subcommands: [
      new CommandSpec({
        name: 'gmail',
        description: 'Gmail messages',
        arguments: [
          new Argument('--account', { default: 'primary', choices: ['primary', 'work'] }),
        ],
        subcommands: [new CommandSpec({ name: 'send' }), new CommandSpec({ name: 'list' })],
      }),
      new CommandSpec({
        name: 'docs',
        description: 'Google Docs',
        subcommands: [new CommandSpec({ name: 'cat' })],
      }),
    ],
  })
}

describe('walk', () => {
  it('resolves a leaf and keeps its argv', () => {
    const result = walk('gws', tree(), ['gmail', 'send', '-t', 'a@x.com', 'hi'])
    expect(result.leaf?.name).toBe('send')
    expect(result.path).toEqual(['gmail', 'send'])
    expect(result.argv).toEqual(['-t', 'a@x.com', 'hi'])
    expect(result.exitCode).toBe(0)
  })

  it('collects group options per level', () => {
    const result = walk('gws', tree(), [
      '-C',
      '/tmp',
      '-vv',
      'gmail',
      '--account=work',
      'send',
      'x',
    ])
    expect(result.leaf).not.toBeNull()
    expect(result.groupFlags).toEqual({ '--cwd': '/tmp', '--verbose': 2, '--account': 'work' })
    expect(result.argv).toEqual(['x'])
  })

  it('lands group defaults as if typed', () => {
    const result = walk('gws', tree(), ['gmail', 'list'])
    expect(result.leaf).not.toBeNull()
    expect(result.groupFlags).toEqual({ '--account': 'primary' })
  })

  it('prints usage to stdout with exit 1 for a bare root', () => {
    const result = walk('gws', tree(), [])
    expect(result.leaf).toBeNull()
    expect(result.stream).toBe('stdout')
    expect(result.exitCode).toBe(1)
    expect(text(result.output).startsWith('usage: gws [-C CWD] [-v] [-h] {gmail,docs} ...')).toBe(
      true,
    )
    expect(text(result.output)).toContain('commands:')
  })

  it('prints the same usage for --help with exit 0', () => {
    const bare = walk('gws', tree(), [])
    const helped = walk('gws', tree(), ['--help'])
    expect(helped.exitCode).toBe(0)
    expect(helped.stream).toBe('stdout')
    expect(text(helped.output)).toBe(text(bare.output))
  })

  it('names the path in nested group help', () => {
    const result = walk('gws', tree(), ['gmail', '--help'])
    expect(result.exitCode).toBe(0)
    expect(
      text(result.output).startsWith(
        'usage: gws gmail [--account {primary,work}] [-h] {send,list} ...',
      ),
    ).toBe(true)
  })

  it('matches git wording for an unknown verb', () => {
    const result = walk('gws', tree(), ['bogus'])
    expect(result.stream).toBe('stderr')
    expect(result.exitCode).toBe(1)
    expect(text(result.output)).toBe("gws: 'bogus' is not a gws command. See 'gws --help'.\n")
  })

  it('names the group path for a nested unknown verb', () => {
    const result = walk('gws', tree(), ['gmail', 'bogus'])
    expect(text(result.output)).toBe(
      "gws: 'bogus' is not a gws gmail command. See 'gws gmail --help'.\n",
    )
  })

  it('renders the installed head in messages', () => {
    const result = walk('gws-work', tree(), ['bogus'])
    expect(text(result.output)).toBe(
      "gws-work: 'bogus' is not a gws-work command. See 'gws-work --help'.\n",
    )
  })

  it('exits 129 with usage for an unknown group option', () => {
    const result = walk('gws', tree(), ['--zzz', 'gmail'])
    expect(result.stream).toBe('stderr')
    expect(result.exitCode).toBe(129)
    expect(text(result.output).startsWith('unknown option: --zzz\n\nusage: gws')).toBe(true)
  })

  it("answers a clap group refusal in clap's words and exit", () => {
    // Probed against ntn 0.21.9: `ntn --bogus` is exit 2, one usage line
    // rather than git's whole help page, and a footer. The dialect is the
    // root's at every level, so a group cannot answer 129 while its own
    // leaves answer 2.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- init wants a plain field bag
    const clap = new CommandSpec({ ...tree(), usageStyle: UsageStyle.CLAP })
    const result = walk('gws', clap, ['--zzz', 'gmail'])
    expect(result.stream).toBe('stderr')
    expect(result.exitCode).toBe(2)
    expect(text(result.output)).toBe(
      "error: unexpected argument '--zzz' found\n\n" +
        'Usage: gws [OPTIONS] <COMMAND>\n\n' +
        "For more information, try '--help'.\n",
    )
  })

  it('names a short token the same way under clap', () => {
    // clap has one wording for long and short alike, unlike git's
    // option/switch split.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- init wants a plain field bag
    const clap = new CommandSpec({ ...tree(), usageStyle: UsageStyle.CLAP })
    const result = walk('gws', clap, ['-Z'])
    expect(result.exitCode).toBe(2)
    expect(text(result.output).split('\n')[0]).toBe("error: unexpected argument '-Z' found")
  })

  it('exits 129 for a starved group value', () => {
    const result = walk('gws', tree(), ['--cwd'])
    expect(result.exitCode).toBe(129)
    expect(text(result.output).startsWith("error: option '--cwd' requires a value")).toBe(true)
  })

  it('refuses a value on a boolean long', () => {
    const result = walk('gws', tree(), ['--verbose=3', 'gmail', 'list'])
    expect(result.exitCode).toBe(129)
    expect(text(result.output).startsWith("error: option '--verbose' takes no value")).toBe(true)
  })

  it('exits 129 for an invalid group choice', () => {
    const result = walk('gws', tree(), ['gmail', '--account=other', 'list'])
    expect(result.exitCode).toBe(129)
    expect(text(result.output).startsWith("error: invalid argument 'other' for '--account'")).toBe(
      true,
    )
  })

  it('handles attached short values and clusters', () => {
    const result = walk('gws', tree(), ['-C/tmp', 'gmail', 'send'])
    expect(result.leaf).not.toBeNull()
    expect(result.groupFlags['--cwd']).toBe('/tmp')
    const clustered = walk('gws', tree(), ['-vvC', '/tmp', 'gmail', 'send'])
    expect(clustered.leaf).not.toBeNull()
    expect(clustered.groupFlags).toEqual({
      '--verbose': 2,
      '--cwd': '/tmp',
      '--account': 'primary',
    })
  })

  it('ends group options at --', () => {
    const result = walk('gws', tree(), ['--', 'gmail', 'send'])
    expect(result.leaf).not.toBeNull()
    expect(result.path).toEqual(['gmail', 'send'])
    const helped = walk('gws', tree(), ['--', '--help'])
    expect(helped.leaf).toBeNull()
    expect(text(helped.output)).toContain('is not a gws command')
  })

  it('lists the injected help flag in group help', () => {
    const result = walk('gws', tree(), ['--help'])
    expect(text(result.output)).toContain('-h, --help')
    expect(text(result.output)).toContain('Show this help and exit')
  })

  it('passes argv through for a leaf root', () => {
    const single = new CommandSpec({ name: 'hello' })
    const result = walk('hello', single, ['--help', '-x', 'arg'])
    expect(result.leaf).toBe(single)
    expect(result.path).toEqual([])
    expect(result.argv).toEqual(['--help', '-x', 'arg'])
  })

  it('handles an optional-value long at group level', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('--color', { nargs: '?', attachedOnly: true })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const attached = walk('tool', spec, ['--color=auto', 'run'])
    expect(attached.leaf).not.toBeNull()
    expect(attached.groupFlags).toEqual({ '--color': 'auto' })
    const bare = walk('tool', spec, ['--color', 'run'])
    expect(bare.leaf).not.toBeNull()
    expect(bare.groupFlags).toEqual({ '--color': true })
  })

  it('handles a multi-char short at group level', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('-name')],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const detached = walk('tool', spec, ['-name', 'foo', 'run'])
    expect(detached.leaf).not.toBeNull()
    expect(detached.groupFlags).toEqual({ '-name': 'foo' })
    const attached = walk('tool', spec, ['-namefoo', 'run'])
    expect(attached.leaf).not.toBeNull()
    expect(attached.groupFlags).toEqual({ '-name': 'foo' })
    const starved = walk('tool', spec, ['-name'])
    expect(starved.exitCode).toBe(129)
    expect(text(starved.output).startsWith("error: option '-name' requires a value")).toBe(true)
  })

  it('exits 129 for a missing required group option', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('--token', { required: true })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const result = walk('tool', spec, ['run'])
    expect(result.exitCode).toBe(129)
    expect(text(result.output).startsWith("error: option '--token' is required")).toBe(true)
    const ok = walk('tool', spec, ['--token', 't', 'run'])
    expect(ok.leaf).not.toBeNull()
    expect(ok.groupFlags).toEqual({ '--token': 't' })
  })
})

describe('walk argparse/git alignment', () => {
  it('resolves an alias to its canonical verb', () => {
    const spec = new CommandSpec({
      name: 'tool',
      subcommands: [
        new CommandSpec({ name: 'checkout', aliases: ['co'], description: 'Switch branches' }),
      ],
    })
    const result = walk('tool', spec, ['co', 'x'])
    expect(result.leaf).not.toBeNull()
    expect(result.path).toEqual(['checkout'])
    expect(result.argv).toEqual(['x'])
  })

  it('renders aliases beside the canonical name', () => {
    const spec = new CommandSpec({
      name: 'tool',
      subcommands: [
        new CommandSpec({
          name: 'checkout',
          aliases: ['co', 'cout'],
          description: 'Switch branches',
        }),
      ],
    })
    const listing = walk('tool', spec, [])
    expect(text(listing.output)).toContain('  checkout (co, cout)  Switch branches')
  })

  it('expands a unique group long prefix like git', () => {
    const result = walk('gws', tree(), ['--verb', '--verb', 'gmail', 'send'])
    expect(result.leaf).not.toBeNull()
    expect(result.groupFlags['--verbose']).toBe(2)
  })

  it('refuses an ambiguous group prefix with git wording', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('--context'), new Argument('--count', { action: 'store_true' })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const result = walk('tool', spec, ['--co', 'run'])
    expect(result.exitCode).toBe(129)
    expect(
      text(result.output).startsWith('error: ambiguous option: co (could be --context or --count)'),
    ).toBe(true)
  })

  it('reaches the injected help through a prefix', () => {
    const full = walk('gws', tree(), ['--help'])
    const abbreviated = walk('gws', tree(), ['--hel'])
    expect(abbreviated.exitCode).toBe(0)
    expect(abbreviated.output).toEqual(full.output)
  })

  it('refuses a non-integer int-typed group value with git wording', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('--depth', { type: 'int' })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const bad = walk('tool', spec, ['--depth', 'x', 'run'])
    expect(bad.exitCode).toBe(129)
    expect(text(bad.output).startsWith("error: option '--depth' expects a numerical value")).toBe(
      true,
    )
    const ok = walk('tool', spec, ['--depth', '-3', 'run'])
    expect(ok.leaf).not.toBeNull()
    expect(ok.groupFlags).toEqual({ '--depth': '-3' })
  })
})

describe('walk float-typed group options', () => {
  it('refuses non-numbers with git wording', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('--ratio', { type: 'float' })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const bad = walk('tool', spec, ['--ratio', '5x', 'run'])
    expect(bad.exitCode).toBe(129)
    expect(text(bad.output).startsWith("error: option '--ratio' expects a numerical value")).toBe(
      true,
    )
    const ok = walk('tool', spec, ['--ratio', '2.5', 'run'])
    expect(ok.leaf).not.toBeNull()
    expect(ok.groupFlags).toEqual({ '--ratio': '2.5' })
  })
})

describe('findChild / findNode', () => {
  it('matches a subcommand by name or alias', () => {
    const spec = new CommandSpec({
      name: 'gws',
      subcommands: [new CommandSpec({ name: 'checkout', aliases: ['co'] })],
    })
    expect(findChild(spec, 'checkout')?.name).toBe('checkout')
    expect(findChild(spec, 'co')?.name).toBe('checkout')
    expect(findChild(spec, 'nope')).toBeNull()
  })

  it('returns the node and its canonical path', () => {
    const found = findNode(tree(), ['gmail', 'send'])
    expect(found?.node.name).toBe('send')
    expect(found?.path).toEqual(['gmail', 'send'])
  })

  it('is the root with no verbs and null on an unknown verb', () => {
    const spec = tree()
    expect(findNode(spec, [])).toEqual({ node: spec, path: [] })
    expect(findNode(spec, ['gmail', 'bogus'])).toBeNull()
    expect(findNode(spec, ['bogus'])).toBeNull()
  })
})

describe('a script root', () => {
  it('terminates the walk with argv verbatim', () => {
    // A script node is a terminal leaf like an fn node: the walk hands
    // back every token so the program can re-parse argv natively.
    const spec = new CommandSpec({ name: 'pager', addHelp: false })
    const result = walk('pager', spec, ['--frobnicate', 'report.txt'])
    expect(result.leaf).toBe(spec)
    expect(result.path).toEqual([])
    expect(result.argv).toEqual(['--frobnicate', 'report.txt'])
    expect(result.exitCode).toBe(0)
  })

  it('owns its argv only when it declares no grammar', () => {
    expect(
      ownsArgv(
        new CLI({ spec: new CommandSpec({ name: 'pager' }), script: new ScriptSource('1') }),
      ),
    ).toBe(true)
    const declared = new CommandSpec({
      name: 'pager',
      arguments: [new Argument('--width', { type: 'int' })],
    })
    expect(ownsArgv(new CLI({ spec: declared, script: new ScriptSource('1') }))).toBe(false)
    expect(
      ownsArgv(
        new CLI({
          spec: new CommandSpec({ name: 'prog' }),
          handlers: { '': new CLIHandler({ fn: () => null }) },
        }),
      ),
    ).toBe(false)
  })

  it('promises no --help in its manual', () => {
    // man renders from the spec, so it must not advertise a --help the
    // program answers itself.
    const text = nodeHelp('pager', new CommandSpec({ name: 'pager', addHelp: false }))
    expect(text.startsWith('usage: pager\n')).toBe(true)
    expect(text).not.toContain('--help')
  })
})

it('lists a child that declares its own --help in the group help', () => {
  // The listed group is grammar only; a rebuilt CommandSpec would refuse the
  // added --help as colliding with the child's own.
  const child = new CommandSpec({
    name: 'run',
    arguments: [new Argument('--help', { action: 'store_true' })],
  })
  expect(nodeHelp('tool', new CommandSpec({ name: 'tool', subcommands: [child] }))).toContain('run')
})

describe('walk path-typed group options', () => {
  it('resolves a relative value against the working directory', () => {
    // A group option declared 'path' has to mean what it means on a leaf, or
    // the type is a lie at exactly one level of the tree.
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('-C', { type: 'path' })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const relative = walk('tool', spec, ['-C', 'build', 'run'], '/repo/src')
    expect(relative.groupFlags).toEqual({
      '-C': PathSpec.fromStrPath('build', undefined, '/repo/src'),
    })
    const absolute = walk('tool', spec, ['-C', '/other', 'run'], '/repo/src')
    expect(absolute.groupFlags).toEqual({
      '-C': PathSpec.fromStrPath('/other'),
    })
  })

  it('lands a default as the working directory', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('-C', { type: 'path', default: '.' })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    expect(walk('tool', spec, ['run'], '/repo/src').groupFlags).toEqual({
      '-C': PathSpec.fromStrPath('.', undefined, '/repo/src'),
    })
  })

  it('resolves every value of a repeated option', () => {
    const spec = new CommandSpec({
      name: 'tool',
      arguments: [new Argument('--dir', { action: 'append', type: 'path' })],
      subcommands: [new CommandSpec({ name: 'run' })],
    })
    const result = walk('tool', spec, ['--dir', 'a', '--dir', '/b', 'run'], '/w')
    expect(result.groupFlags).toEqual({
      '--dir': [PathSpec.fromStrPath('a', undefined, '/w'), PathSpec.fromStrPath('/b')],
    })
  })
})

describe('envNames', () => {
  it('unions Argument.env over the whole tree', () => {
    const tree = new CommandSpec({
      name: 'ntn',
      arguments: [new Argument('--token', { env: 'NOTION_TOKEN' }), new Argument('--plain')],
      subcommands: [
        new CommandSpec({
          name: 'api',
          arguments: [new Argument('--notion-version', { env: 'NOTION_VERSION' })],
        }),
      ],
    })
    expect(envNames(tree)).toEqual(new Set(['NOTION_TOKEN', 'NOTION_VERSION']))
  })

  it('a tree with no env options reads nothing', () => {
    const tree = new CommandSpec({ name: 'x' })
    expect(envNames(tree)).toEqual(new Set())
  })
})

describe('invokedEnvNames', () => {
  const tree = new CommandSpec({
    name: 'tool',
    arguments: [new Argument('--token', { env: 'ROOT_T' })],
    subcommands: [
      new CommandSpec({
        name: 'alpha',
        arguments: [new Argument('--a', { env: 'ALPHA_T' })],
        subcommands: [
          new CommandSpec({ name: 'deep', arguments: [new Argument('--d', { env: 'DEEP_T' })] }),
        ],
      }),
      new CommandSpec({
        name: 'beta',
        aliases: ['b'],
        arguments: [new Argument('--b', { env: 'BETA_T' })],
      }),
    ],
  })

  it('prunes to the selected path', () => {
    expect(invokedEnvNames(tree, new Set())).toEqual(new Set(['ROOT_T']))
    expect(invokedEnvNames(tree, new Set(['alpha']))).toEqual(new Set(['ROOT_T', 'ALPHA_T']))
    expect(invokedEnvNames(tree, new Set(['alpha', 'deep']))).toEqual(
      new Set(['ROOT_T', 'ALPHA_T', 'DEEP_T']),
    )
  })

  it('an alias selects the same node its canonical name does', () => {
    expect(invokedEnvNames(tree, new Set(['b']))).toEqual(new Set(['ROOT_T', 'BETA_T']))
  })

  it('null words mean a dynamic line: the whole tree', () => {
    expect(invokedEnvNames(tree, null)).toEqual(envNames(tree))
  })
})

function envFillTree(): CommandSpec {
  return new CommandSpec({
    name: 'tool',
    arguments: [new Argument('--token', { env: 'ROOT_T' })],
    subcommands: [
      new CommandSpec({
        name: 'alpha',
        arguments: [new Argument('--a', { env: 'ALPHA_T' })],
        subcommands: [
          new CommandSpec({ name: 'deep', arguments: [new Argument('--d', { env: 'DEEP_T' })] }),
        ],
      }),
      new CommandSpec({
        name: 'beta',
        aliases: ['b'],
        arguments: [new Argument('--b', { env: 'BETA_T' })],
      }),
    ],
  })
}

function sharedEnvTree(): CommandSpec {
  return new CommandSpec({
    name: 'tool',
    arguments: [new Argument('--token', { env: 'SHARED' })],
    subcommands: [
      new CommandSpec({ name: 'alpha', arguments: [new Argument('--a', { env: 'SHARED' })] }),
    ],
  })
}

describe('walk group env', () => {
  it('fills at its own level', () => {
    const result = walk('tool', envFillTree(), ['alpha', 'deep'], '/', {
      ROOT_T: 'rv',
      ALPHA_T: 'av',
    })
    expect(result.leaf).not.toBeNull()
    expect(result.groupFlags).toEqual({ '--token': 'rv', '--a': 'av' })
  })

  it('yields to the typed value', () => {
    const result = walk('tool', envFillTree(), ['--token', 'typed', 'alpha', 'deep'], '/', {
      ROOT_T: 'rv',
    })
    expect(result.leaf).not.toBeNull()
    expect(result.groupFlags).toEqual({ '--token': 'typed' })
  })
})

describe('suppliedEnvNames', () => {
  it('tracks destinations, not names', () => {
    // One reader supplied: the unsupplied one still falls back to the
    // variable, so it stays a read.
    expect(suppliedEnvNames(sharedEnvTree(), ['--token', 'x', 'alpha'])).toEqual(new Set())
    // Every reader on the path supplied: nothing consults it.
    expect(suppliedEnvNames(sharedEnvTree(), ['--token', 'x', 'alpha', '--a', 'y'])).toEqual(
      new Set(['SHARED']),
    )
  })

  it('double dash keeps descendants readable', () => {
    // The walk keeps descending after --, so a variable a subcommand
    // can still read is never claimed ...
    expect(suppliedEnvNames(sharedEnvTree(), ['--token', 'x', '--'])).toEqual(new Set())
    // ... while one with no reader below the group stays claimed.
    expect(suppliedEnvNames(envFillTree(), ['--token', 'x', '--'])).toEqual(new Set(['ROOT_T']))
  })
})

it('resolves option-shaped aliases through their declared leaf, after real options', () => {
  const leaf = new CommandSpec({ name: 'version', aliases: ['--version', '-v'] })
  const spec = new CommandSpec({
    name: 'tool',
    arguments: [new Argument('-C', { type: 'path', default: '.' })],
    subcommands: [leaf],
  })
  const result = walk('tool', spec, ['--version'], '/work')
  expect(result.leaf).toBe(leaf)
  expect(result.path).toEqual(['version'])
  expect(result.groupFlags['-C']).toMatchObject({ virtual: '/work' })
  expect(result.argv).toEqual([])
  const other = new CommandSpec({
    name: 'tool',
    arguments: [new Argument('-v', { action: 'store_true' })],
    subcommands: [leaf],
  })
  const flagged = walk('tool', other, ['-v', 'version'])
  expect(flagged.leaf).toBe(leaf)
  expect(flagged.groupFlags['-v']).toBe(true)
})

it('reads an option-shaped alias after -- as an operand, never as the verb', () => {
  const leaf = new CommandSpec({ name: 'version', aliases: ['--version', '-v'] })
  const spec = new CommandSpec({ name: 'tool', subcommands: [leaf] })
  for (const word of ['--version', '-v']) {
    const result = walk('tool', spec, ['--', word])
    expect(result.leaf).toBeNull()
    expect(result.exitCode).toBe(1)
    expect(new TextDecoder().decode(result.output)).toBe(
      `tool: '${word}' is not a tool command. See 'tool --help'.\n`,
    )
  }
  expect(walk('tool', spec, ['--', 'version']).leaf).toBe(leaf)
})

it('refuses -- at the git root like an unknown option, and only there', () => {
  const leaf = new CommandSpec({ name: 'status' })
  const inner = new CommandSpec({ name: 'remote', subcommands: [leaf] })
  const spec = new CommandSpec({
    name: 'git',
    usageStyle: UsageStyle.GIT,
    subcommands: [leaf, inner],
  })
  for (const argv of [['--', 'status'], ['--']]) {
    const result = walk('git', spec, argv)
    expect(result.leaf).toBeNull()
    expect(result.exitCode).toBe(129)
    expect(new TextDecoder().decode(result.output)).toMatch(/^unknown option: --\n/)
  }
  expect(walk('git', spec, ['remote', '--', 'status']).leaf).toBe(leaf)
  const plain = new CommandSpec({ name: 'git', subcommands: [leaf, inner] })
  expect(walk('git', plain, ['--', 'status']).leaf).toBe(leaf)
})

it.each([
  [['-C', '/repo', '-C', 'docs'], '/repo/docs'],
  [['-C', '/repo', '-C', '/other'], '/other'],
  [['-C', 'a', '-C', '../b'], '/work/b'],
  [['-C', '', '-C', 'docs'], '/work/docs'],
  [['-C', 'docs', '-C', ''], '/work/docs'],
  [[], '/work'],
])('moves an operand base like a chdir for %j', (argv, expected) => {
  const git = new CommandSpec({
    name: 'git',
    operandBase: '-C',
    arguments: [new Argument('-C', { type: 'path', default: '.' })],
    subcommands: [new CommandSpec({ name: 'status' })],
  })
  expect(walk('git', git, [...argv, 'status'], '/work').groupFlags['-C']).toMatchObject({
    virtual: expected,
  })
})

const ARITY_TREE = new CommandSpec({
  name: 'tool',
  arguments: [
    new Argument(['-p', '--pair'], { nargs: 2, env: 'PAIR' }),
    new Argument('-v', { action: 'count' }),
    new Argument('-q', { action: 'store_true' }),
    new Argument(['-c', '--color'], { nargs: '?', env: 'COLOR' }),
    new Argument('--gnu', { nargs: '?', attachedOnly: true }),
    new Argument('--file', {
      nargs: 2,
      action: 'extend',
      type: 'path',
      valueTypes: ['str', 'path'],
    }),
  ],
  subcommands: [
    new CommandSpec({ name: 'run', arguments: [new Argument('--token', { env: 'TOKEN' })] }),
  ],
})

it.each([
  ['--pair', 'a', 'b'],
  ['-p', 'a', 'b'],
  ['-pa', 'b'],
  ['-vp', 'a', 'b'],
  ['-vpa', 'b'],
])('consumes fixed-width group arguments before subcommands: %j', (...argv) => {
  const result = walk('tool', ARITY_TREE, [...argv, 'run'])
  expect(result.leaf?.name).toBe('run')
  expect(result.groupFlags['--pair']).toEqual(['a', 'b'])
  expect(result.groupFlags['-v']).toBe(argv[0].startsWith('-v') ? 1 : undefined)
})

it('stores or extends fixed-width group values and resolves mixed path values', () => {
  const result = walk(
    'tool',
    ARITY_TREE,
    [
      '--pair',
      'a',
      'b',
      '--pair',
      'c',
      'd',
      '--file',
      'first',
      'a.txt',
      '--file',
      'second',
      'b.txt',
      'run',
    ],
    '/work',
  )
  expect(result.leaf?.name).toBe('run')
  expect(result.groupFlags['--pair']).toEqual(['c', 'd'])
  expect(result.groupFlags['--file']).toEqual([
    'first',
    PathSpec.fromStrPath('a.txt', undefined, '/work'),
    'second',
    PathSpec.fromStrPath('b.txt', undefined, '/work'),
  ])
})

it.each([
  [['--color', 'auto'], 'auto'],
  [['-c', 'auto'], 'auto'],
  [['-vc', 'auto'], 'auto'],
  [['-vcauto'], 'auto'],
  [['-c', '-1'], '-1'],
  [['--color', '-q'], true],
  [['-vc', '-q'], true],
])('consumes ordinary optional group values: %j', (argv, expected) => {
  const result = walk('tool', ARITY_TREE, [...argv, 'run'])
  expect(result.leaf?.name).toBe('run')
  expect(result.groupFlags['--color']).toBe(expected)
})

it('retains attached-only group values and refuses incomplete fixed widths', () => {
  expect(walk('tool', ARITY_TREE, ['--gnu', 'run']).groupFlags['--gnu']).toBe(true)
  for (const argv of [['--pair', 'a'], ['-pa'], ['--pair=a', 'b', 'run']]) {
    const result = walk('tool', ARITY_TREE, argv)
    expect(result.leaf).toBeNull()
    expect(result.exitCode).not.toBe(0)
  }
})

it('tracks supplied environment values across group argument widths', () => {
  for (const argv of [
    ['--pair', 'a', 'b', '--color', 'auto', 'run', '--token', 'x'],
    ['-pa', 'b', '-c', 'auto', 'run', '--token', 'x'],
  ])
    expect(suppliedEnvNames(ARITY_TREE, argv)).toEqual(new Set(['PAIR', 'COLOR', 'TOKEN']))
  expect(suppliedEnvNames(ARITY_TREE, ['--pair', 'a'])).toEqual(new Set())
})

it('honors addHelp and allowAbbrev on groups', () => {
  const spec = new CommandSpec({
    name: 'tool',
    addHelp: false,
    allowAbbrev: false,
    arguments: [new Argument('--verbose', { action: 'store_true' })],
    subcommands: [new CommandSpec({ name: 'run' })],
  })
  for (const argv of [['--help'], ['-h'], ['--verb', 'run']]) {
    const result = walk('tool', spec, argv)
    expect(result.leaf).toBeNull()
    expect(result.exitCode).not.toBe(0)
  }
  expect(walk('tool', spec, ['--verbose', 'run']).leaf?.name).toBe('run')
})

it('matches longer short spellings before fixed-width prefixes', () => {
  const spec = new CommandSpec({
    name: 'tool',
    arguments: [
      new Argument('-n', { nargs: 2 }),
      new Argument('-name'),
      new Argument('-number', { nargs: '?' }),
    ],
    subcommands: [new CommandSpec({ name: 'run' })],
  })
  const result = walk('tool', spec, ['-name', 'plain', '-number3', 'run'])
  expect(result.leaf?.name).toBe('run')
  expect(result.groupFlags).toEqual({ '-name': 'plain', '-number': '3' })
})
