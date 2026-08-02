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
import { CommandSpec, Operand, OperandKind, Option } from '../spec/types.ts'
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
                valueKind: OperandKind.TEXT,
                multiple: true,
                required: true,
              }),
            ],
            rest: new Operand({ kind: OperandKind.TEXT }),
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
    expect(single.safeguard).toBeNull()
  })

  it('allows group-level options', () => {
    const git = new CLISpec({
      name: 'git',
      options: [new Option({ short: '-C', valueKind: OperandKind.PATH })],
      subcommands: [new CLISpec({ name: 'status', fn: verb })],
    })
    expect(git.options[0]?.short).toBe('-C')
  })

  it('rejects an empty or multi-word name', () => {
    expect(() => new CLISpec({ name: '', fn: verb })).toThrow(/single non-empty word/)
    expect(() => new CLISpec({ name: 'gmail send', fn: verb })).toThrow(/single non-empty word/)
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
    expect(() => new CLISpec({ name: 'gws' })).toThrow(/needs fn or subcommands/)
  })

  it('rejects positional or rest on a group', () => {
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          positional: [new Operand({ kind: OperandKind.TEXT })],
          subcommands: [new CLISpec({ name: 'send', fn: verb })],
        }),
    ).toThrow(/belong on leaves/)
    expect(
      () =>
        new CLISpec({
          name: 'gws',
          rest: new Operand({ kind: OperandKind.TEXT }),
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

  it('stays frozen like every spec', () => {
    const gws = tree()
    expect(Object.isFrozen(gws)).toBe(true)
    expect(Object.isFrozen(gws.subcommands)).toBe(true)
    expect(Object.isFrozen(new CommandSpec({}))).toBe(true)
  })
})
