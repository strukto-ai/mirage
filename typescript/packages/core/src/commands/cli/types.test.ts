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
import { ScriptSource } from '../../runtime/policy/types.ts'
import { CommandSpec, Operand, Option } from '../spec/types.ts'
import { CLISpec, type CLIVerbFn } from './types.ts'

const verb: CLIVerbFn = () => null

const configModel = (input: Record<string, unknown>) => input

function tree(): CLISpec {
  return new CLISpec({
    name: 'gws',
    description: 'Google Workspace',
    configModel,
    subcommands: [
      new CLISpec({
        name: 'gmail',
        description: 'Gmail messages',
        subcommands: [
          new CLISpec({
            name: 'send',
            fn: verb,
            write: true,
            options: [
              new Option({
                short: '-t',
                long: '--to',
                type: 'str',
                multiple: true,
                required: true,
              }),
            ],
            rest: new Operand({ type: 'str' }),
          }),
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

describe('CLISpec', () => {
  it('builds a tree and is a CommandSpec', () => {
    const gws = tree()
    expect(gws).toBeInstanceOf(CommandSpec)
    expect(gws.subcommands.map((child) => child.name)).toEqual(['gmail', 'docs'])
    const gmail = gws.subcommands[0]
    const send = gmail?.subcommands[0]
    expect(send?.write).toBe(true)
    expect(send?.fn).toBe(verb)
    expect(send?.options[0]?.long).toBe('--to')
    expect(gws.configModel).toBe(configModel)
    expect(gmail?.configModel).toBeNull()
  })

  it('allows a single-verb leaf root', () => {
    const single = new CLISpec({ name: 'hello', fn: verb })
    expect(single.subcommands).toEqual([])
    expect(single.write).toBe(false)
    expect(single.limit).toBeNull()
  })

  it('allows group-level options', () => {
    const git = new CLISpec({
      name: 'git',
      options: [new Option({ short: '-C', type: 'path' })],
      subcommands: [new CLISpec({ name: 'status', fn: verb })],
    })
    expect(git.options[0]?.short).toBe('-C')
  })

  it('rejects an empty, multi-word, or whitespace-bearing name', () => {
    expect(() => new CLISpec({ name: '', fn: verb })).toThrow(/single non-empty word/)
    expect(() => new CLISpec({ name: 'gmail send', fn: verb })).toThrow(/single non-empty word/)
    expect(() => new CLISpec({ name: 'gmail\tsend', fn: verb })).toThrow(/single non-empty word/)
    expect(() => new CLISpec({ name: 'gmail\n', fn: verb })).toThrow(/single non-empty word/)
  })

  it('rejects fn together with subcommands', () => {
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          fn: verb,
          subcommands: [new CLISpec({ name: 'send', fn: verb })],
        }),
    ).toThrow(/not both/)
  })

  it('rejects a node with neither fn nor subcommands', () => {
    expect(() => new CLISpec({ name: 'gws' })).toThrow(/needs fn, subcommands, or script/)
  })

  it('a script root stands alone', () => {
    const spec = new CLISpec({ name: 'pager', script: new ScriptSource("print('hi')") })
    expect(spec.fn).toBeNull()
    expect(spec.subcommands).toEqual([])
  })

  it('script excludes fn and subcommands', () => {
    expect(() => new CLISpec({ name: 'pager', fn: verb, script: new ScriptSource('1') })).toThrow(
      /fn or script, not both/,
    )
    expect(
      () =>
        new CLISpec({
          name: 'pager',
          script: new ScriptSource('1'),
          subcommands: [new CLISpec({ name: 'send', fn: verb })],
        }),
    ).toThrow(/subcommands belong to fn trees/)
  })

  it('runtime takes script', () => {
    expect(() => new CLISpec({ name: 'pager', fn: verb, runtime: 'monty' })).toThrow(
      /it takes script/,
    )
    const spec = new CLISpec({ name: 'pager', script: new ScriptSource('1'), runtime: 'monty' })
    expect(spec.runtime).toBe('monty')
  })

  it('script is root only', () => {
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          subcommands: [new CLISpec({ name: 'pager', script: new ScriptSource('1') })],
        }),
    ).toThrow(/only the root of a tree may/)
  })

  it('rejects positional or rest on a group', () => {
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          positional: [new Operand({ type: 'str' })],
          subcommands: [new CLISpec({ name: 'send', fn: verb })],
        }),
    ).toThrow(/belong on leaves/)
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          rest: new Operand({ type: 'str' }),
          subcommands: [new CLISpec({ name: 'send', fn: verb })],
        }),
    ).toThrow(/belong on leaves/)
  })

  it('rejects duplicate subcommand names', () => {
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          subcommands: [
            new CLISpec({ name: 'send', fn: verb }),
            new CLISpec({ name: 'send', fn: verb }),
          ],
        }),
    ).toThrow(/duplicate subcommand 'send'/)
  })

  it('rejects configModel below the root', () => {
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          subcommands: [new CLISpec({ name: 'gmail', fn: verb, configModel })],
        }),
    ).toThrow(/only the root of a tree may/)
  })

  it('rejects an option colliding between a node and a descendant', () => {
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          options: [new Option({ short: '-C', long: '--cwd', type: 'str' })],
          subcommands: [
            new CLISpec({
              name: 'gmail',
              subcommands: [
                new CLISpec({
                  name: 'send',
                  fn: verb,
                  options: [new Option({ long: '--cwd', type: 'str' })],
                }),
              ],
            }),
          ],
        }),
    ).toThrow(/option '--cwd' collides with subcommand 'gmail send'/)
  })

  it('allows sibling leaves to share option spellings', () => {
    const spec = new CLISpec({
      name: 'gws',
      subcommands: [
        new CLISpec({
          name: 'send',
          fn: verb,
          options: [new Option({ long: '--to', type: 'str' })],
        }),
        new CLISpec({
          name: 'share',
          fn: verb,
          options: [new Option({ long: '--to', type: 'str' })],
        }),
      ],
    })
    expect(spec.subcommands).toHaveLength(2)
  })

  it('stays frozen like every spec', () => {
    const gws = tree()
    expect(Object.isFrozen(gws)).toBe(true)
    expect(Object.isFrozen(gws.subcommands)).toBe(true)
    expect(Object.isFrozen(new CommandSpec({}))).toBe(true)
  })
})

describe('CLISpec aliases', () => {
  it('shares one sibling namespace between names and aliases', () => {
    expect(
      () =>
        new CLISpec({
          name: 'tool',
          subcommands: [
            new CLISpec({ name: 'checkout', aliases: ['co'], fn: verb }),
            new CLISpec({ name: 'co', fn: verb }),
          ],
        }),
    ).toThrow(/duplicate subcommand 'co'/)
  })

  it('refuses a multi-word alias', () => {
    expect(
      () =>
        new CLISpec({
          name: 'tool',
          subcommands: [new CLISpec({ name: 'checkout', aliases: ['c o'], fn: verb })],
        }),
    ).toThrow(/alias 'c o'/)
  })
})
