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
import { Option } from '../spec/types.ts'
import { CLISpec, type CLIVerbFn } from './types.ts'
import { walk } from './walk.ts'

const verb: CLIVerbFn = () => null

const DEC = new TextDecoder()

function text(output: Uint8Array): string {
  return DEC.decode(output)
}

function tree(): CLISpec {
  return new CLISpec({
    name: 'gws',
    description: 'Google Workspace',
    options: [
      new Option({
        short: '-C',
        long: '--cwd',
        type: 'str',
        description: 'run as if started there',
      }),
      new Option({ short: '-v', long: '--verbose', count: true }),
    ],
    subcommands: [
      new CLISpec({
        name: 'gmail',
        description: 'Gmail messages',
        options: [
          new Option({
            long: '--account',
            type: 'str',
            default: 'primary',
            choices: ['primary', 'work'],
          }),
        ],
        subcommands: [
          new CLISpec({ name: 'send', fn: verb, write: true }),
          new CLISpec({ name: 'list', fn: verb }),
        ],
      }),
      new CLISpec({
        name: 'docs',
        description: 'Google Docs',
        subcommands: [new CLISpec({ name: 'cat', fn: verb })],
      }),
    ],
  })
}

describe('walk', () => {
  it('resolves a leaf and keeps its argv', () => {
    const result = walk('gws', tree(), ['gmail', 'send', '-t', 'a@x.com', 'hi'])
    expect(result.leaf?.write).toBe(true)
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
    expect(
      text(result.output).startsWith(
        'gws: Google Workspace\n\nUsage: gws [flags] <command> [<args>]',
      ),
    ).toBe(true)
    expect(text(result.output)).toContain('Commands:')
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
        'gws gmail: Gmail messages\n\nUsage: gws gmail [flags] <command> [<args>]',
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
    expect(text(result.output).startsWith('unknown option: --zzz\n\ngws: Google Workspace')).toBe(
      true,
    )
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
    expect(text(result.output)).toContain('\n  --help')
    expect(text(result.output)).toContain('Show this help and exit')
  })

  it('passes argv through for a leaf root', () => {
    const single = new CLISpec({ name: 'hello', fn: verb })
    const result = walk('hello', single, ['--help', '-x', 'arg'])
    expect(result.leaf).toBe(single)
    expect(result.path).toEqual([])
    expect(result.argv).toEqual(['--help', '-x', 'arg'])
  })

  it('handles an optional-value long at group level', () => {
    const spec = new CLISpec({
      name: 'tool',
      options: [new Option({ long: '--color', type: 'str', valueOptional: true })],
      subcommands: [new CLISpec({ name: 'run', fn: verb })],
    })
    const attached = walk('tool', spec, ['--color=auto', 'run'])
    expect(attached.leaf).not.toBeNull()
    expect(attached.groupFlags).toEqual({ '--color': 'auto' })
    const bare = walk('tool', spec, ['--color', 'run'])
    expect(bare.leaf).not.toBeNull()
    expect(bare.groupFlags).toEqual({ '--color': true })
  })

  it('handles a multi-char short at group level', () => {
    const spec = new CLISpec({
      name: 'tool',
      options: [new Option({ short: '-name', type: 'str' })],
      subcommands: [new CLISpec({ name: 'run', fn: verb })],
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
    const spec = new CLISpec({
      name: 'tool',
      options: [new Option({ long: '--token', type: 'str', required: true })],
      subcommands: [new CLISpec({ name: 'run', fn: verb })],
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
    const spec = new CLISpec({
      name: 'tool',
      subcommands: [
        new CLISpec({
          name: 'checkout',
          aliases: ['co'],
          description: 'Switch branches',
          fn: verb,
        }),
      ],
    })
    const result = walk('tool', spec, ['co', 'x'])
    expect(result.leaf).not.toBeNull()
    expect(result.path).toEqual(['checkout'])
    expect(result.argv).toEqual(['x'])
  })

  it('renders aliases beside the canonical name', () => {
    const spec = new CLISpec({
      name: 'tool',
      subcommands: [
        new CLISpec({
          name: 'checkout',
          aliases: ['co', 'cout'],
          description: 'Switch branches',
          fn: verb,
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
    const spec = new CLISpec({
      name: 'tool',
      options: [new Option({ long: '--context', type: 'str' }), new Option({ long: '--count' })],
      subcommands: [new CLISpec({ name: 'run', fn: verb })],
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
    const spec = new CLISpec({
      name: 'tool',
      options: [new Option({ long: '--depth', type: 'int' })],
      subcommands: [new CLISpec({ name: 'run', fn: verb })],
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
    const spec = new CLISpec({
      name: 'tool',
      options: [new Option({ long: '--ratio', type: 'float' })],
      subcommands: [new CLISpec({ name: 'run', fn: verb })],
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
