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
import { ScriptSource } from '../../runtime/types.ts'
import { Operand, Option } from '../spec/types.ts'
import { CLISpec, type CLIVerbFn } from './types.ts'

const verb: CLIVerbFn = () => null

const configModel = (input: Record<string, unknown>) => input

describe('validateCli', () => {
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

  it('script excludes configModel', () => {
    expect(
      () =>
        new CLISpec({
          name: 'pager',
          script: new ScriptSource('1'),
          configModel,
        }),
    ).toThrow(/configModel/)
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

  it('validates leaf option grammar at construction', () => {
    expect(
      () =>
        new CLISpec({
          name: 'mine',
          fn: verb,
          options: [new Option({ long: '--mode', choices: ['a', 'b'] })],
        }),
    ).toThrow(/choices and default require a value flag/)
  })

  it('rejects a spelling-less leaf option at construction', () => {
    expect(() => new CLISpec({ name: 'mine', fn: verb, options: [new Option()] })).toThrow(
      /requires a short or long spelling/,
    )
  })

  it('rejects a duplicate leaf option spelling at construction', () => {
    expect(
      () =>
        new CLISpec({
          name: 'mine',
          fn: verb,
          options: [new Option({ long: '--mode' }), new Option({ long: '--mode', type: 'str' })],
        }),
    ).toThrow(/duplicate option spelling/)
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
